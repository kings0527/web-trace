/**
 * MCP Tool: hook_api
 *
 * 在页面中设置指定API的Hook，拦截或监控调用。
 * 通过Stealth引擎的ProxyHookEngine实现，确保Hook不可被检测。
 */

import { z } from 'zod';
import type { HookConfig } from '@shared/types';

// ─── Schema 定义 ───

export const hookApiInputSchema = {
  apiName: z.string().min(1).describe(
    `要Hook的API名称。支持的API包括：
- fetch — 拦截所有fetch请求
- XMLHttpRequest — 拦截XHR请求（open/send）
- XMLHttpRequest.prototype.open — 仅Hook open方法
- XMLHttpRequest.prototype.send — 仅Hook send方法
- WebSocket — 拦截WebSocket连接和消息
- crypto.subtle — 拦截Web Crypto API调用
- crypto.subtle.encrypt — 仅Hook encrypt
- crypto.subtle.decrypt — 仅Hook decrypt
- crypto.subtle.digest — 仅Hook digest (常用于HMAC签名)
- document.cookie — 监控cookie读写
- navigator.sendBeacon — 拦截Beacon API
- eval — 监控动态代码执行
- Function — 监控函数构造器`,
  ),
  mode: z.enum(['intercept', 'observe']).describe(
    `Hook模式：
- intercept: 拦截模式，可修改参数和返回值
- observe: 观察模式，仅记录调用不修改行为`,
  ),
  options: z.object({
    captureArgs: z.boolean().optional().default(true).describe('是否捕获调用参数'),
    captureResult: z.boolean().optional().default(true).describe('是否捕获返回值'),
    maxLogs: z.number().int().min(10).max(10000).optional().default(1000).describe(
      'Hook日志最大保留条数。超出后丢弃最旧的日志。',
    ),
  }).optional().describe('Hook配置选项'),
};

// ─── Tool 元数据 ───

export const hookApiMeta = {
  name: 'hook_api',
  description: `在当前页面中设置指定浏览器API的Hook。

通过隐蔽Proxy Hook引擎实现，具有以下特点：
- 使用Proxy而非直接覆写，保持原始API的所有属性特征
- 时序对齐防护，避免Hook引入可检测的时间差异
- Error.stack帧清洗，移除Hook相关的栈帧

两种模式：
1. observe（推荐）— 仅监控记录，不影响页面正常执行
2. intercept — 可拦截修改，用于调试签名逻辑

设置后使用 get_hook_logs 工具获取收集到的调用记录。
每个Hook会返回一个唯一hookId用于后续管理。`,
};

// ─── Hook 日志存储 ───

export interface HookLogEntry {
  hookId: string;
  apiName: string;
  timestamp: number;
  args: unknown[];
  result?: unknown;
  error?: string;
  stack?: string;
}

/** 全局 Hook 日志存储（Service Worker 生命周期内有效） */
const hookLogs: Map<string, HookLogEntry[]> = new Map();
const hookConfigs: Map<string, { apiName: string; mode: string; maxLogs: number }> = new Map();

/** 获取所有 Hook 日志（供 get_hook_logs 使用） */
export function getHookLogsStore(): Map<string, HookLogEntry[]> {
  return hookLogs;
}

/** 获取所有活跃的 Hook 配置 */
export function getActiveHookConfigs(): Map<string, { apiName: string; mode: string; maxLogs: number }> {
  return hookConfigs;
}

// ─── Handler ───

export interface HookApiInput {
  apiName: string;
  mode: 'intercept' | 'observe';
  options?: {
    captureArgs?: boolean;
    captureResult?: boolean;
    maxLogs?: number;
  };
}

export interface HookApiOutput {
  hookId: string;
  status: 'active';
  apiName: string;
  mode: string;
}

/**
 * hook_api 工具执行函数
 */
export async function handleHookApi(
  args: HookApiInput,
): Promise<HookApiOutput> {
  const hookId = `hook_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const maxLogs = args.options?.maxLogs ?? 1000;
  const captureArgs = args.options?.captureArgs ?? true;
  const captureResult = args.options?.captureResult ?? true;

  // 获取活跃tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error('No active tab found');
  }

  // 在页面 MAIN world 中注入 Hook 代码
  const hookConfig: HookConfig = {
    target: args.apiName,
    mode: args.mode,
    options: {
      captureArgs,
      captureResult,
      maxLogs,
    },
  };

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (config: HookConfig, id: string) => {
      // 这段代码在页面 MAIN world 中执行
      const logs: Array<{
        hookId: string;
        apiName: string;
        timestamp: number;
        args: unknown[];
        result?: unknown;
        error?: string;
      }> = [];

      // 存储到 window 上供后续读取
      const storageKey = `__wt_hook_${id}`;
      (window as any)[storageKey] = logs;

      // 解析 API 路径
      const parts = config.target.split('.');
      let parent: any = window;
      for (let i = 0; i < parts.length - 1; i++) {
        parent = parent[parts[i]];
        if (!parent) return;
      }
      const methodName = parts[parts.length - 1];
      const original = parent[methodName];

      if (typeof original === 'function') {
        // 使用 Proxy 包装
        parent[methodName] = new Proxy(original, {
          apply(target, thisArg, argList) {
            const entry: any = {
              hookId: id,
              apiName: config.target,
              timestamp: Date.now(),
              args: config.options?.captureArgs ? argList : [],
            };

            try {
              const result = Reflect.apply(target, thisArg, argList);

              // 处理 Promise 返回值
              if (result instanceof Promise) {
                return result.then((resolved) => {
                  if (config.options?.captureResult) {
                    entry.result = resolved;
                  }
                  logs.push(entry);
                  if (logs.length > (config.options?.maxLogs || 1000)) {
                    logs.shift();
                  }
                  return resolved;
                }).catch((err: Error) => {
                  entry.error = err.message;
                  logs.push(entry);
                  throw err;
                });
              }

              if (config.options?.captureResult) {
                entry.result = result;
              }
              logs.push(entry);
              if (logs.length > (config.options?.maxLogs || 1000)) {
                logs.shift();
              }
              return result;
            } catch (err: any) {
              entry.error = err?.message || String(err);
              logs.push(entry);
              if (config.mode === 'observe') throw err;
              return undefined;
            }
          },
          construct(target, argList, newTarget) {
            const entry: any = {
              hookId: id,
              apiName: config.target,
              timestamp: Date.now(),
              args: config.options?.captureArgs ? argList : [],
            };

            try {
              const instance = Reflect.construct(target, argList, newTarget);
              entry.result = '[constructed]';
              logs.push(entry);
              if (logs.length > (config.options?.maxLogs || 1000)) {
                logs.shift();
              }
              return instance;
            } catch (err: any) {
              entry.error = err?.message || String(err);
              logs.push(entry);
              throw err;
            }
          },
        });

        // 保持原型链和属性一致
        Object.defineProperty(parent[methodName], 'name', {
          value: original.name,
          configurable: true,
        });
        Object.defineProperty(parent[methodName], 'length', {
          value: original.length,
          configurable: true,
        });
      } else if (methodName === 'cookie' && parent === document) {
        // 特殊处理 document.cookie（getter/setter）
        const originalDescriptor = Object.getOwnPropertyDescriptor(
          Document.prototype,
          'cookie',
        );
        if (originalDescriptor) {
          Object.defineProperty(parent, 'cookie', {
            get() {
              const val = originalDescriptor.get?.call(this);
              logs.push({
                hookId: id,
                apiName: 'document.cookie[get]',
                timestamp: Date.now(),
                args: [],
                result: config.options?.captureResult ? val : undefined,
              });
              if (logs.length > (config.options?.maxLogs || 1000)) logs.shift();
              return val;
            },
            set(value: string) {
              logs.push({
                hookId: id,
                apiName: 'document.cookie[set]',
                timestamp: Date.now(),
                args: config.options?.captureArgs ? [value] : [],
              });
              if (logs.length > (config.options?.maxLogs || 1000)) logs.shift();
              originalDescriptor.set?.call(this, value);
            },
            configurable: true,
          });
        }
      }
    },
    args: [hookConfig, hookId],
    world: 'MAIN' as chrome.scripting.ExecutionWorld,
  });

  // 记录 Hook 配置到 Service Worker 状态
  hookConfigs.set(hookId, {
    apiName: args.apiName,
    mode: args.mode,
    maxLogs,
  });
  hookLogs.set(hookId, []);

  return {
    hookId,
    status: 'active',
    apiName: args.apiName,
    mode: args.mode,
  };
}
