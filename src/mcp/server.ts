/**
 * WebTrace MCP Server
 *
 * 基于 @modelcontextprotocol/sdk 的 McpServer 高级API，
 * 暴露所有 WebTrace 工具供 AI Agent（Qoder/Cursor/Claude Code等）调用。
 *
 * 特性：
 * - 互斥锁：同一时间仅一个Tool执行（避免浏览器API并发冲突）
 * - 35秒超时保护
 * - 完善的错误处理和日志
 * - 支持多种 Transport（RuntimePort/WebSocket/InMemory）
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { MCP_TOOL_TIMEOUT } from '@shared/constants';

import {
  // detect_protection
  detectProtectionInputSchema,
  detectProtectionMeta,
  handleDetectProtection,
  // analyze_jsvmp
  analyzeJsvmpInputSchema,
  analyzeJsvmpMeta,
  handleAnalyzeJsvmp,
  // trace_execution
  traceExecutionInputSchema,
  traceExecutionMeta,
  handleTraceExecution,
  // extract_bytecode
  extractBytecodeInputSchema,
  extractBytecodeMeta,
  handleExtractBytecode,
  // hook_api
  hookApiInputSchema,
  hookApiMeta,
  handleHookApi,
  // get_hook_logs
  getHookLogsInputSchema,
  getHookLogsMeta,
  handleGetHookLogs,
  // page_state
  pageStateMeta,
  handlePageState,
  // deobfuscate
  deobfuscateInputSchema,
  deobfuscateMeta,
  handleDeobfuscate,
  // extract_wasm
  extractWasmInputSchema,
  extractWasmMeta,
  handleExtractWasm,
  // analyze_wasm
  analyzeWasmInputSchema,
  analyzeWasmMeta,
  handleAnalyzeWasm,
  // dump_wasm_memory
  dumpWasmMemoryInputSchema,
  dumpWasmMemoryMeta,
  handleDumpWasmMemory,
} from './tools';

// ─── 互斥锁 ───

class Mutex {
  private _locked = false;
  private _queue: Array<() => void> = [];

  async acquire(): Promise<void> {
    if (!this._locked) {
      this._locked = true;
      return;
    }
    return new Promise<void>((resolve) => {
      this._queue.push(resolve);
    });
  }

  release(): void {
    if (this._queue.length > 0) {
      const next = this._queue.shift()!;
      next();
    } else {
      this._locked = false;
    }
  }

  get isLocked(): boolean {
    return this._locked;
  }
}

/** 全局工具执行互斥锁 */
const toolMutex = new Mutex();

// ─── 超时包装器 ───

/**
 * 为 handler 添加超时和互斥锁保护
 */
function withProtection<TArgs, TResult>(
  toolName: string,
  handler: (args: TArgs) => Promise<TResult>,
): (args: TArgs) => Promise<CallToolResult> {
  return async (args: TArgs): Promise<CallToolResult> => {
    // 获取互斥锁
    await toolMutex.acquire();
    const startTime = Date.now();

    try {
      // 超时 Promise
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error(`[${toolName}] Execution timed out after ${MCP_TOOL_TIMEOUT}ms`));
        }, MCP_TOOL_TIMEOUT);
      });

      // 执行 handler（与超时竞争）
      const result = await Promise.race([handler(args), timeoutPromise]);

      const elapsed = Date.now() - startTime;
      console.log(`[MCP] ${toolName} completed in ${elapsed}ms`);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      const elapsed = Date.now() - startTime;
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(`[MCP] ${toolName} failed after ${elapsed}ms:`, errorMessage);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: errorMessage,
              tool: toolName,
              elapsedMs: elapsed,
            }),
          },
        ],
        isError: true,
      };
    } finally {
      toolMutex.release();
    }
  };
}

// ─── MCP Server 实例 ───

let mcpServer: McpServer | null = null;
let currentTransport: Transport | null = null;
const bridgeServers = new Map<string, { server: McpServer; transport: Transport }>();

/**
 * 创建并配置 MCP Server 实例
 */
function createConfiguredMCPServer(): McpServer {
  const server = new McpServer(
    {
      name: 'WebTrace',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
      instructions: `WebTrace MCP Server - AI驱动的JSVMP自动化逆向工具集。

提供以下能力：
1. detect_protection — 检测页面反爬保护类型和等级
2. analyze_jsvmp — 分析JSVMP代码结构，识别VM派发循环
3. trace_execution — 在QuickJS沙箱中执行代码并收集trace
4. extract_bytecode — 从页面中提取JSVMP字节码数组
5. hook_api — 在页面中设置API Hook
6. get_hook_logs — 获取Hook收集到的日志
7. page_state — 获取当前页面完整状态
8. deobfuscate — 对JS代码执行反混淆
9. extract_wasm — 提取页面中的WASM模块
10. analyze_wasm — 反汇编分析WASM模块，识别加密算法
11. dump_wasm_memory — 读取WASM实例的线性内存

工作流建议：
- 先用 detect_protection 了解保护类型
- 用 page_state 获取页面全貌
- 用 hook_api + get_hook_logs 监控关键API调用
- 用 extract_bytecode 提取字节码
- 用 analyze_jsvmp 分析VM结构
- 用 deobfuscate 清洗混淆代码
- 用 trace_execution 追踪执行逻辑
- 用 extract_wasm 提取WASM模块
- 用 analyze_wasm 分析WASM加密算法
- 用 dump_wasm_memory 读取WASM内存数据`,
    },
  );

  // ─── 注册所有工具 ───

  // 1. detect_protection
  server.tool(
    detectProtectionMeta.name,
    detectProtectionMeta.description,
    detectProtectionInputSchema,
    withProtection(detectProtectionMeta.name, handleDetectProtection),
  );

  // 2. analyze_jsvmp
  server.tool(
    analyzeJsvmpMeta.name,
    analyzeJsvmpMeta.description,
    analyzeJsvmpInputSchema,
    withProtection(analyzeJsvmpMeta.name, handleAnalyzeJsvmp),
  );

  // 3. trace_execution
  server.tool(
    traceExecutionMeta.name,
    traceExecutionMeta.description,
    traceExecutionInputSchema,
    withProtection(traceExecutionMeta.name, handleTraceExecution),
  );

  // 4. extract_bytecode
  server.tool(
    extractBytecodeMeta.name,
    extractBytecodeMeta.description,
    extractBytecodeInputSchema,
    withProtection(extractBytecodeMeta.name, handleExtractBytecode),
  );

  // 5. hook_api
  server.tool(
    hookApiMeta.name,
    hookApiMeta.description,
    hookApiInputSchema,
    withProtection(hookApiMeta.name, handleHookApi),
  );

  // 6. get_hook_logs
  server.tool(
    getHookLogsMeta.name,
    getHookLogsMeta.description,
    getHookLogsInputSchema,
    withProtection(getHookLogsMeta.name, handleGetHookLogs),
  );

  // 7. page_state（无参数工具）
  server.tool(
    pageStateMeta.name,
    pageStateMeta.description,
    withProtection(pageStateMeta.name, handlePageState as any),
  );

  // 8. deobfuscate
  server.tool(
    deobfuscateMeta.name,
    deobfuscateMeta.description,
    deobfuscateInputSchema,
    withProtection(deobfuscateMeta.name, handleDeobfuscate),
  );

  // 9. extract_wasm
  server.tool(
    extractWasmMeta.name,
    extractWasmMeta.description,
    extractWasmInputSchema,
    withProtection(extractWasmMeta.name, handleExtractWasm),
  );

  // 10. analyze_wasm
  server.tool(
    analyzeWasmMeta.name,
    analyzeWasmMeta.description,
    analyzeWasmInputSchema,
    withProtection(analyzeWasmMeta.name, handleAnalyzeWasm),
  );

  // 11. dump_wasm_memory
  server.tool(
    dumpWasmMemoryMeta.name,
    dumpWasmMemoryMeta.description,
    dumpWasmMemoryInputSchema,
    withProtection(dumpWasmMemoryMeta.name, handleDumpWasmMemory),
  );

  return server;
}

export function createMCPServer(): McpServer {
  mcpServer = createConfiguredMCPServer();
  return mcpServer;
}

export function createBridgeMCPServer(): McpServer {
  return createConfiguredMCPServer();
}

/**
 * 启动 MCP Server 并连接到指定 Transport
 */
export async function startServer(transport: Transport): Promise<void> {
  if (!mcpServer) {
    createMCPServer();
  }

  if (currentTransport) {
    console.warn('[MCP Server] Already connected, closing existing transport');
    await stopServer();
  }

  currentTransport = transport;
  await mcpServer!.connect(transport);
  console.log('[MCP Server] Started and connected to transport');
}

/**
 * 停止 MCP Server
 */
export async function stopServer(): Promise<void> {
  if (mcpServer) {
    await mcpServer.close();
  }
  currentTransport = null;
  console.log('[MCP Server] Stopped');
}

/**
 * 启动独立的 WebSocket bridge MCP Server。
 * RuntimePort 和 bridge 各用一个 McpServer 实例，避免单 transport 限制导致互相关闭。
 */
export async function startBridgeServer(
  transport: Transport,
  connectionId = 'default',
): Promise<void> {
  if (bridgeServers.has(connectionId)) {
    console.warn(`[MCP Bridge Server] Replacing existing bridge transport: ${connectionId}`);
    await stopBridgeServer(connectionId);
  }

  const bridgeMCPServer = createBridgeMCPServer();
  bridgeServers.set(connectionId, { server: bridgeMCPServer, transport });
  await bridgeMCPServer.connect(transport);
  console.log(`[MCP Bridge Server] Started and connected to transport: ${connectionId}`);
}

export async function stopBridgeServer(connectionId?: string): Promise<void> {
  if (connectionId) {
    const bridge = bridgeServers.get(connectionId);
    if (bridge) {
      await bridge.server.close();
      bridgeServers.delete(connectionId);
    }
    console.log(`[MCP Bridge Server] Stopped: ${connectionId}`);
    return;
  }

  for (const [id, bridge] of bridgeServers) {
    await bridge.server.close();
    bridgeServers.delete(id);
  }
  console.log('[MCP Bridge Server] Stopped all bridge transports');
}

/**
 * 获取当前 MCP Server 实例
 */
export function getMCPServer(): McpServer | null {
  return mcpServer;
}

/**
 * 检查 Server 是否正在运行
 */
export function isServerRunning(): boolean {
  return mcpServer?.isConnected() ?? false;
}

export function isBridgeServerRunning(): boolean {
  for (const bridge of bridgeServers.values()) {
    if (bridge.server.isConnected()) {
      return true;
    }
  }
  return false;
}

export function getBridgeServerConnectionIds(): string[] {
  return [...bridgeServers.keys()];
}
