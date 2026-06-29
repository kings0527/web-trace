/**
 * WebTrace Service Worker - 主入口
 * 职责：初始化Offscreen Document、管理MCP Server、路由Tab消息
 *
 * 生命周期要点：
 * - Service Worker可能随时被kill（30s无活动）
 * - 每次唤醒都需要重新初始化状态
 * - Offscreen Document保持后台存活以运行WASM
 */

import { OffscreenManager } from './offscreen-manager';
import type { InternalMessage, TabState } from '@shared/types';
import { isWebTraceMessage, createMessage } from '@shared/message-protocol';
import { createMCPServer, startServer, stopServer, isServerRunning } from '@mcp/server';
import { RuntimePortTransport, createWebSocketTransport } from '@mcp/transport';

// ─── 全局状态（Service Worker每次唤醒都会重新执行顶层代码） ───

/** Offscreen文档管理器 */
let offscreenManager: OffscreenManager | null = null;

/** 已注入hook的Tab状态表 */
const tabStates: Map<number, TabState> = new Map();

/** 是否已完成初始化 */
let initialized = false;

/** MCP Server 是否已启动 */
let mcpInitialized = false;

/** Extension 版本和能力元数据 */
export const EXTENSION_META = {
  name: 'WebTrace',
  version: '1.0.0',
  capabilities: [
    'detect_protection',
    'analyze_jsvmp',
    'trace_execution',
    'extract_bytecode',
    'hook_api',
    'get_hook_logs',
    'page_state',
    'deobfuscate',
  ],
  transport: ['runtime-port', 'websocket'],
  protocol: 'MCP/1.0',
} as const;

// ─── 初始化逻辑 ───

/**
 * 核心初始化函数
 * Service Worker每次被唤醒时调用
 */
async function initializeServiceWorker(): Promise<void> {
  if (initialized && offscreenManager) return;

  try {
    console.log('[WebTrace SW] Initializing...');

    // 创建并初始化Offscreen Manager
    offscreenManager = new OffscreenManager();
    await offscreenManager.initialize();

    initialized = true;
    console.log('[WebTrace SW] Initialization complete');
  } catch (err) {
    console.error('[WebTrace SW] Initialization failed:', err);
    initialized = false;
    offscreenManager = null;
  }
}

/**
 * 确保Service Worker已初始化（用于事件处理器中）
 */
async function ensureInitialized(): Promise<OffscreenManager> {
  if (!initialized || !offscreenManager) {
    await initializeServiceWorker();
  }
  if (!offscreenManager) {
    throw new Error('[WebTrace SW] Failed to initialize OffscreenManager');
  }
  return offscreenManager;
}

// ─── 消息路由 ───

/**
 * 处理来自Content Script的消息
 */
async function handleContentMessage(
  message: InternalMessage,
  sender: chrome.runtime.MessageSender
): Promise<unknown> {
  const tabId = sender.tab?.id;

  switch (message.type) {
    case 'REQUEST_INJECT': {
      // Content Script请求注入inject脚本到MAIN world
      if (tabId === undefined) {
        return { success: false, error: 'No tab ID' };
      }
      try {
        await chrome.scripting.executeScript({
          target: {
            tabId,
            allFrames: false,
          },
          files: ['inject/index.js'],
          world: 'MAIN' as chrome.scripting.ExecutionWorld,
          injectImmediately: true,
        });
        console.log(`[WebTrace SW] Injected into tab ${tabId}`);
        return { success: true };
      } catch (err) {
        console.error(`[WebTrace SW] Inject failed for tab ${tabId}:`, err);
        return { success: false, error: String(err) };
      }
    }

    case 'INJECT_READY': {
      // Content Script已注入并准备就绪
      if (tabId !== undefined) {
        tabStates.set(tabId, {
          tabId,
          url: sender.tab?.url || '',
          injected: true,
          hookConfigs: [],
        });
        console.log(`[WebTrace SW] Tab ${tabId} inject ready`);
      }
      return { success: true };
    }

    case 'TRACE_DATA': {
      // 转发trace数据到offscreen进行分析
      try {
        const manager = await ensureInitialized();
        const result = await manager.sendTask('QUICKJS_EXECUTE', message.payload);
        return { success: true, data: result };
      } catch (err) {
        console.error('[WebTrace SW] Failed to process trace data:', err);
        return { success: false, error: String(err) };
      }
    }

    case 'ANALYZE_REQUEST': {
      // AST分析请求 → 路由到offscreen的Babel
      try {
        const manager = await ensureInitialized();
        const result = await manager.sendTask('BABEL_ANALYZE', message.payload);
        return { success: true, data: result };
      } catch (err) {
        console.error('[WebTrace SW] Failed to analyze:', err);
        return { success: false, error: String(err) };
      }
    }

    case 'HOOK_LOG': {
      // Hook日志，暂存到Tab状态中（后续MCP工具可读取）
      if (tabId !== undefined) {
        console.log(`[WebTrace SW] Hook log from tab ${tabId}:`, message.payload);
      }
      return { success: true };
    }

    default:
      console.warn(`[WebTrace SW] Unknown message type: ${message.type}`);
      return { success: false, error: `Unknown message type: ${message.type}` };
  }
}

// ─── 事件监听注册（必须在顶层同步注册） ───

/**
 * Extension 安装/更新事件
 */
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log(`[WebTrace SW] onInstalled: ${details.reason}`);
  await initializeServiceWorker();
});

/**
 * Service Worker启动事件（浏览器重启或SW被唤醒）
 */
chrome.runtime.onStartup.addListener(async () => {
  console.log('[WebTrace SW] onStartup');
  await initializeServiceWorker();
});

/**
 * 消息监听器 - 路由所有内部消息
 */
chrome.runtime.onMessage.addListener(
  (message: unknown, sender: chrome.runtime.MessageSender, sendResponse) => {
    // 只处理WebTrace内部消息
    if (!isWebTraceMessage(message)) return false;

    // 忽略来自offscreen的响应消息（由OffscreenManager内部处理）
    const msg = message as InternalMessage;
    if (
      (msg.type as string) === 'RESULT' ||
      (msg.type as string) === 'HEARTBEAT'
    ) {
      return false;
    }

    // 异步处理消息并返回结果
    handleContentMessage(msg, sender)
      .then((result) => sendResponse(result))
      .catch((err) => {
        console.error('[WebTrace SW] Message handler error:', err);
        sendResponse({ success: false, error: String(err) });
      });

    // 返回true表示异步发送响应
    return true;
  }
);

/**
 * Tab更新事件 - 页面导航时跟踪状态
 */
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // 页面完成加载时检查是否需要重新注入
  if (changeInfo.status === 'complete' && tab.url) {
    const state = tabStates.get(tabId);
    if (state) {
      // URL变化说明页面导航了，重置注入状态
      if (state.url !== tab.url) {
        state.url = tab.url;
        state.injected = false;
      }
    }
  }
});

/**
 * Tab关闭事件 - 清理状态
 */
chrome.tabs.onRemoved.addListener((tabId) => {
  tabStates.delete(tabId);
  console.log(`[WebTrace SW] Tab ${tabId} removed, state cleaned`);
});

// ─── MCP Server 初始化与管理 ───

/**
 * 获取当前所有Tab状态（供MCP工具使用）
 */
export function getTabStates(): Map<number, TabState> {
  return tabStates;
}

/**
 * 获取OffscreenManager实例（供MCP工具使用）
 */
export function getOffscreenManager(): OffscreenManager | null {
  return offscreenManager;
}

/**
 * 初始化 MCP Server 并绑定 RuntimePort Transport
 * 外部 Agent 通过 chrome.runtime.connect 建立长连接
 */
export async function initMCPServer(): Promise<void> {
  if (mcpInitialized && isServerRunning()) {
    console.log('[WebTrace SW] MCP Server already running');
    return;
  }

  try {
    // Create MCP Server instance
    createMCPServer();

    // Start with RuntimePort transport (primary: extension internal + external agents)
    const runtimeTransport = new RuntimePortTransport('webtrace-mcp');
    await startServer(runtimeTransport);

    mcpInitialized = true;
    console.log('[WebTrace SW] MCP Server started with RuntimePort transport');
  } catch (err) {
    console.error('[WebTrace SW] MCP Server initialization failed:', err);
    mcpInitialized = false;
  }
}

/**
 * 尝试连接 WebSocket bridge（可选，供外部AI Agent使用）
 * 如果本机有 bridge 进程运行在指定端口，Extension 将作为 WS client 连接
 */
export async function connectWebSocketBridge(port: number = 3100): Promise<boolean> {
  try {
    const wsTransport = createWebSocketTransport(port);
    await startServer(wsTransport);
    console.log(`[WebTrace SW] Connected to WebSocket bridge on port ${port}`);
    return true;
  } catch (err) {
    console.warn(`[WebTrace SW] WebSocket bridge connection failed (port ${port}):`, err);
    return false;
  }
}

// ─── 外部 Agent 长连接支持 ───

/**
 * 监听外部 Agent 通过 chrome.runtime.connect 建立的连接
 * 支持 externally_connectable 配置的外部扩展或 NativeMessaging Host
 */
chrome.runtime.onConnectExternal.addListener((port) => {
  console.log(`[WebTrace SW] External connection from: ${port.sender?.id || 'unknown'}`);

  if (port.name === 'webtrace-mcp') {
    // MCP protocol connection — handled by RuntimePortTransport
    console.log('[WebTrace SW] External MCP client connected');
    return;
  }

  if (port.name === 'webtrace-info') {
    // Info query — return extension metadata
    port.postMessage({
      type: 'extension_info',
      data: EXTENSION_META,
    });
    port.disconnect();
    return;
  }

  // Unknown port name
  port.postMessage({ type: 'error', message: `Unknown port name: ${port.name}` });
  port.disconnect();
});

/**
 * 处理来自外部扩展的单次消息（externally_connectable）
 */
chrome.runtime.onMessageExternal.addListener(
  (message: unknown, sender: chrome.runtime.MessageSender, sendResponse) => {
    if (typeof message !== 'object' || message === null) {
      sendResponse({ error: 'Invalid message format' });
      return false;
    }

    const msg = message as Record<string, unknown>;

    // Query extension info
    if (msg.type === 'get_info') {
      sendResponse({ success: true, data: EXTENSION_META });
      return false;
    }

    // Query MCP server status
    if (msg.type === 'get_status') {
      sendResponse({
        success: true,
        data: {
          mcpRunning: isServerRunning(),
          initialized,
          tabCount: tabStates.size,
        },
      });
      return false;
    }

    sendResponse({ error: `Unknown message type: ${msg.type}` });
    return false;
  },
);

// ─── 立即初始化（Service Worker加载时） ───
initializeServiceWorker()
  .then(() => initMCPServer())
  .catch((err) => {
    console.error('[WebTrace SW] Top-level init failed:', err);
  });
