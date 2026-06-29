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
    captureRequestHeaders?: boolean;
    captureResponseHeaders?: boolean;
    captureRequestBody?: boolean;
    captureResponseBody?: boolean;
    maxResponseBodySize?: number;
    maxLogs?: number;
  };
}

// ─── WASM 分析相关类型 ───

/** WASM Section 通用结构 */
export interface WasmSection {
  id: number;
  name: string;
  offset: number;
  size: number;
  data: Uint8Array;
}

/** WASM 模块提取信息 */
export interface WasmModuleInfo {
  source: string;          // 来源（URL或inline）
  size: number;            // 字节大小
  exports: string[];       // 导出函数列表
  imports: { module: string; name: string; kind: string }[];
  memoryPages: number;     // 初始内存页数
  tableSize: number;       // 函数表大小
  customSections: string[]; // 自定义section名
}

/** WASM 函数信息 */
export interface WasmFunctionInfo {
  index: number;
  name: string;
  params: string[];
  results: string[];
  localCount: number;
  bodySize: number;
  callees: number[];
}

/** 加密算法特征匹配 */
export interface CryptoSignature {
  type: 'AES' | 'SHA256' | 'ChaCha20' | 'SM3' | 'SM4' | 'MD5' | 'unknown';
  confidence: number;
  evidence: string[];
}

/** WASM 类型定义 */
export type WasmValType = 'i32' | 'i64' | 'f32' | 'f64' | 'v128' | 'funcref' | 'externref';

/** WASM 导入条目 */
export interface WasmImportEntry {
  module: string;
  name: string;
  kind: 'function' | 'table' | 'memory' | 'global';
  typeIndex?: number;
}

/** WASM 导出条目 */
export interface WasmExportEntry {
  name: string;
  kind: 'function' | 'table' | 'memory' | 'global';
  index: number;
}

/** WASM 反汇编指令 */
export interface WasmInstruction {
  offset: number;
  opcode: number;
  mnemonic: string;
  operands: (number | string)[];
}

/** WASM 解析后的模块结构 */
export interface ParsedWasmModule {
  version: number;
  sections: WasmSection[];
  types: { params: WasmValType[]; results: WasmValType[] }[];
  imports: WasmImportEntry[];
  exports: WasmExportEntry[];
  functions: WasmFunctionInfo[];
  memoryPages: number;
  tableSize: number;
  customSections: string[];
  dataSegments: { offset: number; data: Uint8Array }[];
}
