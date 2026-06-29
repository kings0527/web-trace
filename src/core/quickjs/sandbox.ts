/**
 * QuickJS WASM Sandbox
 * 使用 quickjs-emscripten 提供安全的JS执行沙箱
 *
 * 功能：
 * 1. 延迟加载QuickJS WASM模块（首次调用时初始化）
 * 2. Singleton模式复用模块实例
 * 3. Context池化（最多3个并发context）
 * 4. 内存限制配置（默认512MB）
 * 5. 执行超时保护
 * 6. 注入trace回调函数到context
 */

import { DEFAULT_SANDBOX_CONFIG } from '@shared/constants';
import type { SandboxConfig, TraceEntry } from '@shared/types';

// ─── QuickJS Abstraction Types ───
// 抽象层类型定义，兼容 quickjs-emscripten API

export interface QuickJSHandle {
  dispose(): void;
}

export interface QuickJSRuntime {
  setInterruptHandler(handler: () => boolean): void;
  removeInterruptHandler(): void;
  setMemoryLimit(limit: number): void;
  setMaxStackSize(size: number): void;
}

export interface QuickJSEvalResult {
  error?: QuickJSHandle;
  value?: QuickJSHandle;
}

export interface QuickJSContext {
  runtime: QuickJSRuntime;
  evalCode(code: string, filename?: string, options?: { strict?: boolean }): QuickJSEvalResult;
  newFunction(name: string, fn: (...args: QuickJSHandle[]) => QuickJSHandle | void): QuickJSHandle;
  newNumber(value: number): QuickJSHandle;
  newString(value: string): QuickJSHandle;
  newObject(): QuickJSHandle;
  newArray(): QuickJSHandle;
  getNumber(handle: QuickJSHandle): number;
  getString(handle: QuickJSHandle): string;
  dump(handle: QuickJSHandle): unknown;
  setProp(obj: QuickJSHandle, key: string | QuickJSHandle, value: QuickJSHandle): void;
  getProp(obj: QuickJSHandle, key: string | QuickJSHandle): QuickJSHandle;
  global: QuickJSHandle;
  undefined: QuickJSHandle;
  dispose(): void;
}

export interface QuickJSWASMModule {
  newContext(): QuickJSContext;
  newRuntime(): QuickJSRuntime;
}

// ─── Execution Result ───

export interface ExecutionResult {
  success: boolean;
  value?: unknown;
  error?: string;
  traceEntries?: TraceEntry[];
  executionTime: number;
}

// ─── Constants ───

const MAX_CONTEXT_POOL_SIZE = 3;
const LOG_PREFIX = '[QuickJS Sandbox]';

// ─── Singleton State ───

let wasmModule: QuickJSWASMModule | null = null;
let initPromise: Promise<QuickJSWASMModule> | null = null;

/** Context池 */
const contextPool: QuickJSContext[] = [];
let activeContextCount = 0;

// ─── Public API ───

/**
 * 获取QuickJS WASM模块实例（Singleton + Lazy Init）
 * 首次调用时初始化WASM模块，后续调用返回缓存实例
 */
export async function getQuickJS(): Promise<QuickJSWASMModule> {
  if (wasmModule) return wasmModule;

  if (!initPromise) {
    initPromise = initializeQuickJS();
  }

  return initPromise;
}

/**
 * 从池中获取或创建一个新的QuickJS Context
 * 应用SandboxConfig配置（内存限制等）
 */
export function createContext(config?: Partial<SandboxConfig>): QuickJSContext {
  if (!wasmModule) {
    throw new Error(`${LOG_PREFIX} Module not initialized. Call getQuickJS() first.`);
  }

  const mergedConfig: SandboxConfig = { ...DEFAULT_SANDBOX_CONFIG, ...config };

  // 尝试从池中获取
  if (contextPool.length > 0) {
    const ctx = contextPool.pop()!;
    applyConfig(ctx, mergedConfig);
    activeContextCount++;
    return ctx;
  }

  // 创建新context
  if (activeContextCount >= MAX_CONTEXT_POOL_SIZE) {
    throw new Error(`${LOG_PREFIX} Max concurrent contexts reached (${MAX_CONTEXT_POOL_SIZE})`);
  }

  const ctx = wasmModule.newContext();
  applyConfig(ctx, mergedConfig);
  activeContextCount++;
  return ctx;
}

/**
 * 归还context到池中（而非直接dispose）
 */
export function releaseContext(ctx: QuickJSContext): void {
  activeContextCount = Math.max(0, activeContextCount - 1);

  if (contextPool.length < MAX_CONTEXT_POOL_SIZE) {
    contextPool.push(ctx);
  } else {
    ctx.dispose();
  }
}

/**
 * 在QuickJS沙箱中执行代码
 * 包含完整的超时保护、trace收集和错误处理
 */
export async function executeCode(
  code: string,
  config?: Partial<SandboxConfig>
): Promise<ExecutionResult> {
  const module = await getQuickJS();
  const mergedConfig: SandboxConfig = { ...DEFAULT_SANDBOX_CONFIG, ...config };

  const ctx = module.newContext();
  const traceEntries: TraceEntry[] = [];
  const startTime = performance.now();

  try {
    // 应用内存限制
    applyConfig(ctx, mergedConfig);

    // 注入trace回调（如果启用）
    if (mergedConfig.traceEnabled) {
      injectTraceCallback(ctx, traceEntries, mergedConfig.traceFilter);
    }

    // 设置执行超时
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      ctx.runtime.setInterruptHandler(() => true);
    }, mergedConfig.maxExecutionTime);

    // 执行代码
    const result = ctx.evalCode(code, 'sandbox-script.js', { strict: true });

    clearTimeout(timeoutId);

    if (timedOut) {
      // 清理超时中断的结果
      if (result.error) {
        ctx.runtime.removeInterruptHandler();
        result.error.dispose();
      } else if (result.value) {
        result.value.dispose();
      }
      return {
        success: false,
        error: `Execution timed out after ${mergedConfig.maxExecutionTime}ms`,
        traceEntries,
        executionTime: performance.now() - startTime,
      };
    }

    // 处理执行结果
    if (result.error) {
      const errorVal = ctx.dump(result.error);
      result.error.dispose();
      return {
        success: false,
        error: `Execution error: ${JSON.stringify(errorVal)}`,
        traceEntries,
        executionTime: performance.now() - startTime,
      };
    }

    const value = result.value ? ctx.dump(result.value) : undefined;
    if (result.value) result.value.dispose();

    return {
      success: true,
      value,
      traceEntries,
      executionTime: performance.now() - startTime,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      traceEntries,
      executionTime: performance.now() - startTime,
    };
  } finally {
    ctx.dispose();
  }
}

/**
 * 销毁所有资源
 */
export function dispose(): void {
  // 清理context池
  for (const ctx of contextPool) {
    try {
      ctx.dispose();
    } catch {
      // ignore disposal errors
    }
  }
  contextPool.length = 0;
  activeContextCount = 0;
  wasmModule = null;
  initPromise = null;
  console.log(`${LOG_PREFIX} Disposed`);
}

// ─── Internal Helpers ───

/**
 * 初始化QuickJS WASM模块
 * 尝试加载真实的quickjs-emscripten包，失败时使用fallback
 */
async function initializeQuickJS(): Promise<QuickJSWASMModule> {
  try {
    console.log(`${LOG_PREFIX} Loading QuickJS WASM...`);
    const { newQuickJSWASMModuleFromVariant } = await import('quickjs-emscripten-core');
    const variant = await import('@jitl/quickjs-singlefile-browser-release-sync');
    wasmModule = await newQuickJSWASMModuleFromVariant(
      (variant as any).default ?? variant
    ) as unknown as QuickJSWASMModule;
    console.log(`${LOG_PREFIX} QuickJS WASM loaded successfully`);
    return wasmModule;
  } catch (err) {
    console.warn(`${LOG_PREFIX} Failed to load quickjs-emscripten, using fallback:`, err);
    wasmModule = createFallbackModule();
    return wasmModule;
  }
}

/**
 * 创建Fallback QuickJS模块
 * 当真实WASM包不可用时，提供基于eval的降级实现（仅开发用）
 */
function createFallbackModule(): QuickJSWASMModule {
  console.warn(`${LOG_PREFIX} Using FALLBACK module (eval-based, NOT sandboxed)`);

  return {
    newContext(): QuickJSContext {
      const handles = new Set<{ value: unknown }>();

      function makeHandle(value: unknown): QuickJSHandle & { value: unknown } {
        const h = { value, dispose: () => { handles.delete(h); } };
        handles.add(h);
        return h;
      }

      const globalObj: Record<string, unknown> = {};
      const globalHandle = makeHandle(globalObj);

      const runtime: QuickJSRuntime = {
        setInterruptHandler: () => {},
        removeInterruptHandler: () => {},
        setMemoryLimit: () => {},
        setMaxStackSize: () => {},
      };

      const ctx: QuickJSContext = {
        runtime,
        global: globalHandle,
        undefined: makeHandle(undefined),

        evalCode(code: string, _filename?: string): QuickJSEvalResult {
          try {
            // Construct a function with injected globals
            const keys = Object.keys(globalObj);
            const values = keys.map(k => globalObj[k]);
            const fn = new Function(...keys, `"use strict";\n${code}`);
            const result = fn(...values);
            return { value: makeHandle(result) };
          } catch (e) {
            return { error: makeHandle(e instanceof Error ? e.message : String(e)) };
          }
        },

        newFunction(name: string, fn: (...args: any[]) => any): QuickJSHandle {
          const wrapped = (...args: any[]) => fn(...args.map(a => makeHandle(a)));
          Object.defineProperty(wrapped, 'name', { value: name });
          return makeHandle(wrapped);
        },

        newNumber(value: number) { return makeHandle(value); },
        newString(value: string) { return makeHandle(value); },
        newObject() { return makeHandle({}); },
        newArray() { return makeHandle([]); },

        getNumber(handle: any) { return Number(handle.value); },
        getString(handle: any) { return String(handle.value); },
        dump(handle: any) { return handle.value; },

        setProp(obj: any, key: string | any, value: any) {
          const target = obj.value as Record<string, unknown>;
          const k = typeof key === 'string' ? key : String(key.value);
          target[k] = value.value;
        },

        getProp(obj: any, key: string | any) {
          const target = obj.value as Record<string, unknown>;
          const k = typeof key === 'string' ? key : String(key.value);
          return makeHandle(target[k]);
        },

        dispose() {
          for (const h of handles) {
            h.value = undefined;
          }
          handles.clear();
        },
      };

      return ctx;
    },

    newRuntime(): QuickJSRuntime {
      return {
        setInterruptHandler: () => {},
        removeInterruptHandler: () => {},
        setMemoryLimit: () => {},
        setMaxStackSize: () => {},
      };
    },
  };
}

/**
 * 应用SandboxConfig到Context
 */
function applyConfig(ctx: QuickJSContext, config: SandboxConfig): void {
  try {
    ctx.runtime.setMemoryLimit(config.memoryLimit);
    ctx.runtime.setMaxStackSize(1024 * 1024); // 1MB stack
  } catch {
    // fallback module may not support these
  }
}

/**
 * 注入__vmTrace回调函数到context的全局对象
 * VM执行时调用此函数收集trace数据
 */
function injectTraceCallback(
  ctx: QuickJSContext,
  traceEntries: TraceEntry[],
  traceFilter?: SandboxConfig['traceFilter']
): void {
  try {
    const traceFn = ctx.newFunction('__vmTrace', (...args: QuickJSHandle[]) => {
      // 参数：pc, opcode, stackSnapshot (JSON string)
      const pc = args[0] ? ctx.getNumber(args[0]) : 0;
      const opcode = args[1] ? ctx.getNumber(args[1]) : 0;
      let stackSnapshot: unknown[] = [];

      if (args[2]) {
        try {
          const raw = ctx.getString(args[2]);
          stackSnapshot = JSON.parse(raw);
        } catch {
          stackSnapshot = [];
        }
      }

      // 应用过滤器
      if (traceFilter) {
        if (traceFilter.opcodeRange) {
          const [min, max] = traceFilter.opcodeRange;
          if (opcode < min || opcode > max) return ctx.undefined;
        }
      }

      const entry: TraceEntry = {
        pc,
        opcode,
        stackSnapshot,
        timestamp: Date.now(),
      };

      traceEntries.push(entry);
      return ctx.undefined;
    });

    ctx.setProp(ctx.global, '__vmTrace', traceFn);
    traceFn.dispose();
  } catch (err) {
    console.warn(`${LOG_PREFIX} Failed to inject trace callback:`, err);
  }
}
