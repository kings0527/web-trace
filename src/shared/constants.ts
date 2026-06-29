/**
 * WebTrace 常量定义
 */

// Extension 内部消息标识
export const MESSAGE_PREFIX = '__wt';

// 默认配置
export const DEFAULT_SANDBOX_CONFIG = {
  memoryLimit: 512 * 1024 * 1024, // 512MB
  maxExecutionTime: 30000,         // 30s
  traceEnabled: true,
} as const;

// Ring buffer 配置
export const TRACE_BUFFER_SIZE = 10_000;
export const TRACE_FLUSH_INTERVAL = 50; // ms
export const TRACE_FLUSH_THRESHOLD = 0.8; // 80% full triggers flush

// MCP Server 配置
export const MCP_DEFAULT_PORT = 0; // random port
export const MCP_TOOL_TIMEOUT = 35_000; // 35s
export const MCP_BIND_HOST = '127.0.0.1'; // localhost only

// Offscreen heartbeat
export const OFFSCREEN_HEARTBEAT_INTERVAL = 5000; // 5s

// Stealth 配置
export const TIMING_JITTER_RANGE = 5; // ±5ms
export const STACK_FILTER_PATTERNS = [
  'chrome-extension://',
  'inject.js',
  'stealth-bootstrap',
  'vm-tracer',
  '__wt',
] as const;
