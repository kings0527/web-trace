/**
 * MCP Tool: get_hook_logs
 *
 * 获取已设置的Hook收集到的调用日志。
 * 支持按hookId过滤、按API名称过滤、按时间范围过滤。
 */

import { z } from 'zod';
import { getHookLogsStore, getActiveHookConfigs, type HookLogEntry } from './hook-api';

// ─── Schema 定义 ───

export const getHookLogsInputSchema = {
  hookId: z.string().optional().describe(
    '指定hookId获取特定Hook的日志。省略则返回所有活跃Hook的日志。',
  ),
  filter: z.object({
    apiName: z.string().optional().describe('按API名称过滤日志'),
    timeRange: z.object({
      start: z.number().optional().describe('起始时间戳(ms)'),
      end: z.number().optional().describe('结束时间戳(ms)'),
    }).optional().describe('按时间范围过滤'),
  }).optional().describe('日志过滤条件'),
  limit: z.number().int().min(1).max(5000).optional().default(100).describe(
    '返回的最大日志条数。默认100，最大5000。',
  ),
};

// ─── Tool 元数据 ───

export const getHookLogsMeta = {
  name: 'get_hook_logs',
  description: `获取已设置的Hook收集到的API调用日志。

使用方式：
1. 不传参数 — 获取所有活跃Hook的最近100条日志
2. 指定hookId — 获取特定Hook的日志
3. 使用filter过滤 — 按API名称或时间范围筛选

每条日志包含：
- hookId: 来源Hook标识
- apiName: 被调用的API名称
- timestamp: 调用时间戳
- args: 调用参数（如果配置了captureArgs）
- result: 返回值（如果配置了captureResult）
- error: 异常信息（如果调用抛出了错误）

注意：日志存储在页面MAIN世界中，页面导航或刷新后会丢失。`,
};

// ─── Handler ───

export interface GetHookLogsInput {
  hookId?: string;
  filter?: {
    apiName?: string;
    timeRange?: {
      start?: number;
      end?: number;
    };
  };
  limit?: number;
}

export interface GetHookLogsOutput {
  logs: HookLogEntry[];
  totalAvailable: number;
  activeHooks: Array<{ hookId: string; apiName: string; mode: string }>;
}

/**
 * get_hook_logs 工具执行函数
 */
export async function handleGetHookLogs(
  args: GetHookLogsInput,
): Promise<GetHookLogsOutput> {
  const limit = args.limit ?? 100;
  const configs = getActiveHookConfigs();

  // 活跃Hook列表
  const activeHooks = Array.from(configs.entries()).map(([id, cfg]) => ({
    hookId: id,
    apiName: cfg.apiName,
    mode: cfg.mode,
  }));

  // 从页面中获取最新的Hook日志
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let allLogs: HookLogEntry[] = [];

  if (tab?.id) {
    // 确定要读取哪些hookId
    const hookIds = args.hookId
      ? [args.hookId]
      : Array.from(configs.keys());

    if (hookIds.length > 0) {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (ids: string[]) => {
          const collected: any[] = [];
          for (const id of ids) {
            const storageKey = `__wt_hook_${id}`;
            const logs = (window as any)[storageKey];
            if (Array.isArray(logs)) {
              collected.push(...logs);
            }
          }
          return collected;
        },
        args: [hookIds],
        world: 'MAIN' as chrome.scripting.ExecutionWorld,
      });

      const rawLogs = results?.[0]?.result;
      if (Array.isArray(rawLogs)) {
        allLogs = rawLogs as HookLogEntry[];
      }
    }
  }

  // 应用过滤
  let filteredLogs = allLogs;

  if (args.hookId) {
    filteredLogs = filteredLogs.filter((log) => log.hookId === args.hookId);
  }

  if (args.filter?.apiName) {
    const apiFilter = args.filter.apiName.toLowerCase();
    filteredLogs = filteredLogs.filter((log) =>
      log.apiName.toLowerCase().includes(apiFilter),
    );
  }

  if (args.filter?.timeRange) {
    const { start, end } = args.filter.timeRange;
    if (start !== undefined) {
      filteredLogs = filteredLogs.filter((log) => log.timestamp >= start);
    }
    if (end !== undefined) {
      filteredLogs = filteredLogs.filter((log) => log.timestamp <= end);
    }
  }

  // 按时间倒序排列
  filteredLogs.sort((a, b) => b.timestamp - a.timestamp);

  const totalAvailable = filteredLogs.length;

  // 应用limit
  filteredLogs = filteredLogs.slice(0, limit);

  return {
    logs: filteredLogs,
    totalAvailable,
    activeHooks,
  };
}
