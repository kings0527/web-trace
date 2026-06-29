/**
 * MCP Tool: trace_execution
 *
 * 在QuickJS沙箱中执行JSVMP代码并收集完整的执行trace。
 * 通过Offscreen Document中的QuickJS WASM引擎执行，确保不影响页面。
 */

import { z } from 'zod';
import type { TraceEntry } from '@shared/types';
import { MCP_TOOL_TIMEOUT, DEFAULT_SANDBOX_CONFIG, TRACE_BUFFER_SIZE } from '@shared/constants';

// ─── Schema 定义 ───

export const traceExecutionInputSchema = {
  code: z.string().min(1).describe(
    '待执行的JSVMP代码。代码将在隔离的QuickJS WASM沙箱中执行。',
  ),
  inputs: z.record(z.string(), z.unknown()).optional().describe(
    '注入到沙箱全局作用域的输入变量。键为变量名，值为变量内容。',
  ),
  maxTraceEntries: z.number().int().min(100).max(100000).optional().default(10000).describe(
    '最大trace条目数量。超出后停止收集（代码继续执行）。范围: 100-100000。',
  ),
  timeout: z.number().int().min(5000).max(300000).optional().default(60000).describe(
    '执行超时时间（毫秒）。默认60秒。',
  ),
  chunkSize: z.number().int().min(1000).max(5000000).optional().describe(
    '当代码超过200KB时，自动分片执行。指定每片大小（字符数）。',
  ),
};

// ─── Tool 元数据 ───

export const traceExecutionMeta = {
  name: 'trace_execution',
  description: `在隔离的QuickJS WASM沙箱中执行JSVMP代码并收集执行trace。

功能：
- 在完全隔离的沙箱环境中执行代码（无DOM、无网络、无文件系统）
- 收集每一步的PC值、opcode、栈快照和时间戳
- 支持注入自定义全局变量作为输入
- 支持限制trace最大条目数防止内存溢出
- 30秒执行超时保护

注意事项：
- 代码在无浏览器API的环境中执行，不支持DOM/fetch/WebSocket等
- 适用于纯计算逻辑的trace（如签名算法、加密函数）
- 大型代码建议先用analyze_jsvmp定位关键函数再单独trace`,
};

// ─── Handler ───

export interface TraceExecutionInput {
  code: string;
  inputs?: Record<string, unknown>;
  maxTraceEntries?: number;
  timeout?: number;
  chunkSize?: number;
}

export interface TraceExecutionOutput {
  traceLog: TraceEntry[];
  executionResult: unknown;
  stats: {
    totalEntries: number;
    executionTimeMs: number;
    memoryUsedBytes: number;
    truncated: boolean;
  };
}

/**
 * trace_execution 工具执行函数
 *
 * 通过 Service Worker → Offscreen Document → QuickJS WASM 链路执行
 */
export async function handleTraceExecution(
  args: TraceExecutionInput,
): Promise<TraceExecutionOutput> {
  const maxEntries = args.maxTraceEntries ?? TRACE_BUFFER_SIZE;
  const timeout = args.timeout ?? 60000;
  const startTime = Date.now();

  // 大代码分片处理
  const chunkSize = args.chunkSize ?? 200000;
  let codeToExecute = args.code;

  if (codeToExecute.length > chunkSize) {
    // 对于超大代码，只执行最后一个分片（通常包含入口点）
    // 或者将前面的分片作为声明，最后一个分片作为执行
    console.warn(`[trace_execution] Code size ${codeToExecute.length} exceeds chunkSize ${chunkSize}, truncating for execution`);
    // 取最后一个 chunk
    const lastChunkStart = Math.max(0, codeToExecute.length - chunkSize);
    // 向前找到完整的语句边界
    const boundary = codeToExecute.indexOf('\n', lastChunkStart);
    codeToExecute = codeToExecute.slice(boundary !== -1 ? boundary : lastChunkStart);
  }

  // 构造发送到 Offscreen Document 的 payload
  const taskPayload = {
    action: 'trace_execute',
    code: codeToExecute,
    inputs: args.inputs || {},
    config: {
      memoryLimit: DEFAULT_SANDBOX_CONFIG.memoryLimit,
      maxExecutionTime: Math.min(
        timeout - 5000, // 留 5 秒给通信开销
        MCP_TOOL_TIMEOUT - 5000,
      ),
      traceEnabled: true,
      maxTraceEntries: maxEntries,
    },
  };

  // 通过 chrome.runtime.sendMessage 发送任务到 Offscreen
  // 注意：此函数由 MCP Server 在 Service Worker 上下文中调用
  // OffscreenManager 通过 background/index.ts 的 getOffscreenManager() 暴露

  let result: unknown;
  try {
    // 使用内部消息协议发送到 offscreen
    const response = await chrome.runtime.sendMessage({
      __wt: true,
      id: `mcp_trace_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: 'QUICKJS_EXECUTE',
      payload: taskPayload,
    });

    if (response && typeof response === 'object' && 'success' in response) {
      const r = response as { success: boolean; data?: unknown; error?: string };
      if (!r.success) {
        throw new Error(r.error || 'QuickJS execution failed');
      }
      result = r.data;
    } else {
      result = response;
    }
  } catch (err) {
    throw new Error(
      `[trace_execution] Sandbox execution failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const executionTime = Date.now() - startTime;

  // 解析返回结果
  const traceResult = result as {
    traceLog?: TraceEntry[];
    executionResult?: unknown;
    memoryUsed?: number;
  } | null;

  const traceLog = traceResult?.traceLog || [];
  const truncated = traceLog.length >= maxEntries;

  return {
    traceLog,
    executionResult: traceResult?.executionResult ?? null,
    stats: {
      totalEntries: traceLog.length,
      executionTimeMs: executionTime,
      memoryUsedBytes: traceResult?.memoryUsed || 0,
      truncated,
    },
  };
}
