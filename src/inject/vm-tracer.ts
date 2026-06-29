/**
 * VM Tracer - VM派发循环Proxy Hook追踪器
 *
 * 功能：
 * 1. 使用ProxyHookEngine Hook Array和TypedArray的构造器
 * 2. 监测大数组（>100元素）的顺序访问模式
 * 3. 当检测到VM派发模式时（连续顺序读取），自动记录trace
 * 4. 将trace数据通过postMessage发送到Content Script
 * 5. 支持手动设置trace目标（通过MCP Tool触发）
 *
 * 检测原理：
 * JSVMP的字节码数组通常是一个大型数组/TypedArray，
 * 派发循环会顺序读取（pc++），因此可通过连续索引访问模式识别。
 */

import { stealthEngine } from './stealth-bootstrap';
import { MESSAGE_PREFIX } from '@shared/constants';
import type { TraceEntry } from '@shared/types';

// ─── 配置常量 ───

/** 触发追踪的最小数组长度 */
const MIN_ARRAY_LENGTH = 100;

/** 连续顺序访问达到此阈值时认为是VM派发 */
const SEQUENTIAL_THRESHOLD = 10;

/** Trace buffer最大容量 */
const TRACE_BUFFER_MAX = 5000;

/** Flush间隔（ms） */
const TRACE_FLUSH_MS = 50;

// ─── 内部状态 ───

/** 正在监控的数组（WeakRef避免内存泄露） */
interface MonitoredArray {
  ref: WeakRef<object>;
  lastIndex: number;
  sequentialCount: number;
  tracing: boolean;
}

/** 监控列表 */
const monitoredArrays: Map<number, MonitoredArray> = new Map();
let nextMonitorId = 0;

/** Trace缓冲区 */
let traceBuffer: TraceEntry[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/** 手动追踪目标（由MCP Tool设置） */
let manualTarget: WeakRef<object> | null = null;

/** 是否已启动 */
let started = false;

// ─── 核心逻辑 ───

/**
 * 发送trace数据到Content Script
 */
function flushTraceBuffer(): void {
  if (traceBuffer.length === 0) return;

  const data = traceBuffer.splice(0, traceBuffer.length);
  window.postMessage(
    {
      __wt: true,
      id: `${MESSAGE_PREFIX}_trace_${Date.now()}`,
      type: 'TRACE_DATA',
      payload: data,
    },
    '*'
  );
}

/**
 * 记录一条trace
 */
function recordTrace(pc: number, opcode: number, stackSnapshot: unknown[]): void {
  const entry: TraceEntry = {
    pc,
    opcode,
    stackSnapshot: stackSnapshot.slice(0, 10), // 仅记录前10个元素
    timestamp: Date.now(),
  };

  traceBuffer.push(entry);

  // 超过缓冲容量立即flush
  if (traceBuffer.length >= TRACE_BUFFER_MAX) {
    flushTraceBuffer();
  } else if (!flushTimer) {
    // 设置延迟flush
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushTraceBuffer();
    }, TRACE_FLUSH_MS);
  }
}

/**
 * 创建数组访问代理
 * 包裹目标数组，监控索引访问模式
 */
function createArrayProxy(target: object, monitorId: number): object {
  const monitor = monitoredArrays.get(monitorId);
  if (!monitor) return target;

  return new Proxy(target, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver);

      // 仅监控数值索引访问
      if (typeof prop === 'string') {
        const index = Number(prop);
        if (Number.isInteger(index) && index >= 0) {
          checkSequentialAccess(monitor, index, value, obj);
        }
      }

      return value;
    },
  });
}

/**
 * 检查是否为顺序访问模式
 */
function checkSequentialAccess(
  monitor: MonitoredArray,
  index: number,
  value: unknown,
  arrayObj: object
): void {
  if (index === monitor.lastIndex + 1) {
    // 连续顺序访问
    monitor.sequentialCount++;

    if (monitor.sequentialCount >= SEQUENTIAL_THRESHOLD) {
      // 达到阈值，开始/继续tracing
      if (!monitor.tracing) {
        monitor.tracing = true;
      }
    }

    if (monitor.tracing) {
      // 获取当前"栈快照"（附近的数组元素作为上下文）
      const arr = arrayObj as unknown[];
      const snapshot = Array.isArray(arr)
        ? arr.slice(Math.max(0, index - 2), index + 3)
        : [];
      recordTrace(index, typeof value === 'number' ? value : 0, snapshot);
    }
  } else {
    // 非顺序访问，重置计数
    monitor.sequentialCount = 0;
    // 如果已经在tracing且跳转了，可能是分支跳转（保持tracing）
    if (monitor.tracing && Math.abs(index - monitor.lastIndex) < 50) {
      const arr = arrayObj as unknown[];
      const snapshot = Array.isArray(arr)
        ? arr.slice(Math.max(0, index - 2), index + 3)
        : [];
      recordTrace(index, typeof value === 'number' ? value : 0, snapshot);
    } else {
      monitor.tracing = false;
    }
  }

  monitor.lastIndex = index;
}

/**
 * Hook Array构造器，拦截大数组的创建
 */
function hookArrayConstructor(): void {
  stealthEngine.hook(globalThis, 'Array', (originalFn, thisArg, args) => {
    const result = Reflect.construct(originalFn as new (...a: unknown[]) => unknown, args);

    // 检测通过Array(n)创建的大数组
    if (args.length === 1 && typeof args[0] === 'number' && args[0] >= MIN_ARRAY_LENGTH) {
      const id = nextMonitorId++;
      monitoredArrays.set(id, {
        ref: new WeakRef(result as object),
        lastIndex: -1,
        sequentialCount: 0,
        tracing: false,
      });
      return createArrayProxy(result as object, id);
    }

    return result;
  });
}

/**
 * Hook Array.from，拦截从可迭代对象创建的大数组
 */
function hookArrayFrom(): void {
  stealthEngine.hook(Array, 'from', (originalFn, thisArg, args) => {
    const result = originalFn.apply(thisArg, args) as unknown[];

    if (Array.isArray(result) && result.length >= MIN_ARRAY_LENGTH) {
      const id = nextMonitorId++;
      monitoredArrays.set(id, {
        ref: new WeakRef(result),
        lastIndex: -1,
        sequentialCount: 0,
        tracing: false,
      });
      return createArrayProxy(result, id);
    }

    return result;
  });
}

/**
 * Hook TypedArray构造器（Uint8Array, Int32Array等）
 */
function hookTypedArrays(): void {
  const typedArrays = [
    'Uint8Array',
    'Uint16Array',
    'Uint32Array',
    'Int8Array',
    'Int16Array',
    'Int32Array',
    'Float32Array',
    'Float64Array',
  ] as const;

  for (const name of typedArrays) {
    const TypedArrayCtor = (globalThis as Record<string, unknown>)[name] as
      | (new (...args: unknown[]) => object)
      | undefined;
    if (!TypedArrayCtor) continue;

    stealthEngine.hook(globalThis, name, (originalFn, _thisArg, args) => {
      const result = Reflect.construct(originalFn as new (...a: unknown[]) => object, args);

      // 检查TypedArray长度
      const length = (result as { length?: number }).length;
      if (length && length >= MIN_ARRAY_LENGTH) {
        const id = nextMonitorId++;
        monitoredArrays.set(id, {
          ref: new WeakRef(result),
          lastIndex: -1,
          sequentialCount: 0,
          tracing: false,
        });
        return createArrayProxy(result, id);
      }

      return result;
    });
  }
}

/**
 * 设置手动追踪目标（由MCP Tool通过消息触发）
 */
export function setTraceTarget(target: object): void {
  manualTarget = new WeakRef(target);
  const id = nextMonitorId++;
  monitoredArrays.set(id, {
    ref: manualTarget,
    lastIndex: -1,
    sequentialCount: 0,
    tracing: true, // 手动目标直接开始tracing
  });
}

/**
 * 监听来自Content Script的TRACE_TARGET消息
 */
function listenForTraceTargets(): void {
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (
      data &&
      data.__wt === true &&
      data.type === 'TRACE_TARGET'
    ) {
      // payload包含追踪配置
      const config = data.payload as {
        arrayName?: string;
        enabled?: boolean;
      };

      if (config.enabled === false) {
        // 停止所有追踪
        for (const monitor of monitoredArrays.values()) {
          monitor.tracing = false;
        }
        flushTraceBuffer();
      }
      // 如果指定了arrayName，尝试在全局查找
      if (config.arrayName) {
        const target = (globalThis as Record<string, unknown>)[config.arrayName];
        if (target && typeof target === 'object') {
          setTraceTarget(target);
        }
      }
    }
  });
}

/**
 * 初始化VM追踪器
 * 安装所有Hook并开始监控
 */
export function initVMTracer(): void {
  if (started) return;
  started = true;

  // 安装Array/TypedArray Hook
  hookArrayConstructor();
  hookArrayFrom();
  hookTypedArrays();

  // 监听MCP Tool的追踪目标指令
  listenForTraceTargets();
}
