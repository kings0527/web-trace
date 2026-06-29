/**
 * MCP Transport Layer
 *
 * 在 Chrome Extension Service Worker 中实现 MCP Transport 接口。
 * 支持两种模式：
 * 1. RuntimeTransport — 通过 chrome.runtime port 与同浏览器内的客户端通信
 * 2. WebSocketTransport — 通过 WebSocket 连接到外部 bridge (localhost) 实现 AI Agent 对接
 *
 * 注意：Extension Service Worker 无法创建 WebSocket Server，
 * 因此 WebSocket 模式采用"client-to-bridge"方案 —— Extension 作为 WS client 连接到
 * 本机运行的 Native Messaging Host 或独立 bridge 进程暴露的 ws://127.0.0.1:{port}/mcp。
 */

import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { MCP_BIND_HOST } from '@shared/constants';

// ─── Runtime Port Transport（浏览器内通信） ───

/**
 * 基于 chrome.runtime.Port 的 Transport 实现
 * 用于 Extension 内部 popup/devtools/content 等页面与 MCP Server 通信
 */
export class RuntimePortTransport implements Transport {
  private port: chrome.runtime.Port | null = null;
  sessionId?: string;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(private readonly portName: string = 'webtrace-mcp') {}

  async start(): Promise<void> {
    // 监听来自扩展内客户端的连接
    chrome.runtime.onConnect.addListener((port) => {
      if (port.name !== this.portName) return;
      this.port = port;
      this.sessionId = `runtime_${Date.now()}`;

      port.onMessage.addListener((msg: unknown) => {
        try {
          const jsonrpc = msg as JSONRPCMessage;
          this.onmessage?.(jsonrpc);
        } catch (err) {
          this.onerror?.(err instanceof Error ? err : new Error(String(err)));
        }
      });

      port.onDisconnect.addListener(() => {
        this.port = null;
        this.onclose?.();
      });
    });
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    if (!this.port) {
      throw new Error('[RuntimePortTransport] No connected port');
    }
    this.port.postMessage(message);
  }

  async close(): Promise<void> {
    if (this.port) {
      this.port.disconnect();
      this.port = null;
    }
    this.onclose?.();
  }
}

// ─── WebSocket Client Transport（对外AI Agent通信） ───

/**
 * WebSocket Transport 实现
 *
 * Extension SW 作为 WebSocket Client 连接到本机 bridge 进程。
 * Bridge 进程负责暴露 ws://127.0.0.1:{port}/mcp 供 AI Agent 连接，
 * 并将消息双向转发到 Extension。
 *
 * 如果不需要外部 bridge（直接内嵌模式），也可用于连接到
 * Offscreen Document 中运行的 WebSocket Server。
 */
export class WebSocketClientTransport implements Transport {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _closed = false;

  sessionId?: string;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(
    private readonly url: string = `ws://${MCP_BIND_HOST}:3100/mcp`,
    private readonly autoReconnect: boolean = true,
    private readonly reconnectDelay: number = 3000,
  ) {}

  async start(): Promise<void> {
    await this.connect();
  }

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this._closed) {
        reject(new Error('[WebSocketTransport] Transport has been closed'));
        return;
      }

      try {
        this.ws = new WebSocket(this.url);
        this.sessionId = `ws_${Date.now()}`;

        this.ws.onopen = () => {
          console.log('[WebSocketTransport] Connected to', this.url);
          resolve();
        };

        this.ws.onmessage = (event: MessageEvent) => {
          try {
            const data = typeof event.data === 'string' ? event.data : '';
            const message = JSON.parse(data) as JSONRPCMessage;
            this.onmessage?.(message);
          } catch (err) {
            this.onerror?.(
              err instanceof Error ? err : new Error(`Parse error: ${String(err)}`),
            );
          }
        };

        this.ws.onerror = (event: Event) => {
          const err = new Error(`[WebSocketTransport] WebSocket error: ${String(event)}`);
          this.onerror?.(err);
          reject(err);
        };

        this.ws.onclose = () => {
          this.ws = null;
          if (!this._closed && this.autoReconnect) {
            this.scheduleReconnect();
          } else {
            this.onclose?.();
          }
        };
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this._closed) return;
      try {
        await this.connect();
      } catch {
        // 连接失败，继续重试
        this.scheduleReconnect();
      }
    }, this.reconnectDelay);
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('[WebSocketTransport] WebSocket not connected');
    }
    this.ws.send(JSON.stringify(message));
  }

  async close(): Promise<void> {
    this._closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.onclose?.();
  }
}

// ─── In-Memory Transport（用于测试和内部直连） ───

/**
 * 内存 Transport，用于同进程内直连 MCP Server
 * 适用于 Service Worker 内部的工具直接调用场景
 */
export class InMemoryTransport implements Transport {
  private _peer: InMemoryTransport | null = null;
  private _started = false;

  sessionId?: string;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  /**
   * 创建一对互联的 InMemoryTransport
   */
  static createPair(): [InMemoryTransport, InMemoryTransport] {
    const a = new InMemoryTransport();
    const b = new InMemoryTransport();
    a._peer = b;
    b._peer = a;
    a.sessionId = 'inmemory_a';
    b.sessionId = 'inmemory_b';
    return [a, b];
  }

  async start(): Promise<void> {
    this._started = true;
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    if (!this._peer) {
      throw new Error('[InMemoryTransport] No peer connected');
    }
    // 异步投递，模拟真实传输
    queueMicrotask(() => {
      this._peer?.onmessage?.(message);
    });
  }

  async close(): Promise<void> {
    this._started = false;
    if (this._peer) {
      this._peer._peer = null;
      this._peer.onclose?.();
      this._peer = null;
    }
    this.onclose?.();
  }
}

// ─── 工厂函数 ───

/**
 * 创建适用于 Chrome Extension 内部通信的 Transport
 */
export function createRuntimeTransport(portName?: string): RuntimePortTransport {
  return new RuntimePortTransport(portName);
}

/**
 * 创建 WebSocket Client Transport（连接到本机 bridge）
 * @param port bridge 端口号
 */
export function createWebSocketTransport(port: number = 3100): WebSocketClientTransport {
  return new WebSocketClientTransport(`ws://${MCP_BIND_HOST}:${port}/mcp`);
}

/**
 * 创建内存 Transport 对（用于内部直连）
 */
export function createInMemoryTransport(): [InMemoryTransport, InMemoryTransport] {
  return InMemoryTransport.createPair();
}
