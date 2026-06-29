/**
 * WebTrace 共享类型定义
 */

// MCP Tool 相关类型
export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

// Trace 数据类型
export interface TraceEntry {
  pc: number;
  opcode: number;
  stackSnapshot: unknown[];
  timestamp: number;
}

// VM 派发循环识别结果
export interface VMDispatcherInfo {
  type: 'while-switch' | 'while-if-else' | 'handler-table';
  location: { line: number; column: number };
  bytecodeArrayName: string;
  pcVariableName: string;
  opcodeCount: number;
  cases: Map<number, string>; // opcode -> handler label
}

// 保护类型检测结果
export interface ProtectionInfo {
  type: 'none' | 'obfuscation' | 'jsvmp' | 'wasm' | 'combined';
  level: 1 | 2 | 3 | 4 | 5;
  features: string[];
  confidence: number;
}

// 内部消息类型
export type MessageType =
  | 'REQUEST_INJECT'
  | 'INJECT_READY'
  | 'HOOK_SETUP'
  | 'HOOK_LOG'
  | 'TRACE_DATA'
  | 'TRACE_TARGET'
  | 'ANALYZE_REQUEST'
  | 'ANALYZE_RESULT'
  | 'ERROR';

// Offscreen Document 专用消息类型
export type OffscreenMessageType =
  | 'QUICKJS_EXECUTE'
  | 'BABEL_ANALYZE'
  | 'HEARTBEAT'
  | 'RESULT'
  | 'ERROR';

export interface InternalMessage {
  __wt: true;
  id: string;
  type: MessageType;
  payload: unknown;
}

// Offscreen Document 消息格式
export interface OffscreenMessage {
  __wt: true;
  id: string;
  type: OffscreenMessageType;
  payload: unknown;
}

// Tab状态信息
export interface TabState {
  tabId: number;
  url: string;
  injected: boolean;
  hookConfigs: HookConfig[];
}

// QuickJS 沙箱配置
export interface SandboxConfig {
  memoryLimit: number;       // bytes
  maxExecutionTime: number;  // ms
  traceEnabled: boolean;
  traceFilter?: {
    opcodeRange?: [number, number];
    functionNames?: string[];
  };
}

// Hook 配置
export interface HookConfig {
  target: string;          // e.g., 'fetch', 'XMLHttpRequest.prototype.send'
  mode: 'intercept' | 'observe';
  options?: {
    captureArgs?: boolean;
    captureResult?: boolean;
    maxLogs?: number;
  };
}
