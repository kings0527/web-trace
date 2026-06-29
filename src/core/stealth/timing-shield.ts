/**
 * Timing Shield - 时序对齐防护
 * 防止反爬通过performance.now()/Date.now()的时序差异检测Hook
 *
 * 功能：
 * 1. Hook performance.now() 注入随机jitter（±5ms范围）
 * 2. Hook Date.now() 同步jitter
 * 3. 确保Hook自身逻辑<0.1ms开销（直接调用原函数，避免额外Proxy层）
 * 4. jitter使用正态分布（更自然）而非均匀分布
 * 5. 确保连续调用的单调递增性（now()不能返回比上次小的值）
 */

import { TIMING_JITTER_RANGE } from '@shared/constants';

/** 是否已安装（幂等保护） */
let installed = false;

/** 上一次返回的performance.now值，确保单调递增 */
let lastPerfValue = -Infinity;

/** 上一次返回的Date.now值，确保单调递增 */
let lastDateValue = -Infinity;

/** 保存原始函数引用 */
let originalPerformanceNow: (() => number) | null = null;
let originalDateNow: (() => number) | null = null;

/**
 * Box-Muller变换生成标准正态分布随机数
 * 产生均值为0、标准差为1的正态分布样本
 */
function boxMullerRandom(): number {
  let u1: number;
  let u2: number;

  // 确保u1不为0（log(0)未定义）
  do {
    u1 = Math.random();
  } while (u1 === 0);

  u2 = Math.random();

  // Box-Muller变换
  return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
}

/**
 * 生成±TIMING_JITTER_RANGE范围内的正态分布jitter
 * 使用3σ原则：标准差 = range/3，使99.7%的值落在±range内
 */
function generateJitter(): number {
  const stdDev = TIMING_JITTER_RANGE / 3;
  let jitter = boxMullerRandom() * stdDev;

  // 硬限制在±range范围内（截断尾部）
  if (jitter > TIMING_JITTER_RANGE) jitter = TIMING_JITTER_RANGE;
  if (jitter < -TIMING_JITTER_RANGE) jitter = -TIMING_JITTER_RANGE;

  return jitter;
}

/**
 * 安装时序对齐防护
 * Hook performance.now() 和 Date.now()，注入正态分布的微小jitter
 */
export function installTimingShield(): void {
  if (installed) return;
  installed = true;

  const win = globalThis as unknown as Window & {
    performance?: Performance;
  };

  const originalDefineProperty = Object.defineProperty;

  // ==========================================
  // Hook performance.now()
  // ==========================================
  if (win.performance && typeof win.performance.now === 'function') {
    // 保存原始引用，使用bind确保调用时this正确
    originalPerformanceNow = win.performance.now.bind(win.performance);
    const origPerfNow = originalPerformanceNow;

    // 直接函数替换（避免Proxy开销，确保<0.1ms）
    const hookedPerfNow = function now(): number {
      // 直接调用原始函数 + 微小jitter
      const real = origPerfNow();
      const jittered = real + generateJitter();

      // 确保单调递增
      if (jittered <= lastPerfValue) {
        // 微量递增，确保单调性
        lastPerfValue += 0.001;
      } else {
        lastPerfValue = jittered;
      }

      return lastPerfValue;
    };

    // 伪装函数特征
    originalDefineProperty.call(Object, hookedPerfNow, 'name', {
      value: 'now',
      writable: false,
      enumerable: false,
      configurable: true,
    });

    originalDefineProperty.call(Object, hookedPerfNow, 'length', {
      value: 0,
      writable: false,
      enumerable: false,
      configurable: true,
    });

    // 伪装toString
    originalDefineProperty.call(Object, hookedPerfNow, 'toString', {
      value: function () {
        return 'function now() { [native code] }';
      },
      writable: true,
      enumerable: false,
      configurable: true,
    });

    // 替换
    originalDefineProperty.call(Object, win.performance, 'now', {
      value: hookedPerfNow,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }

  // ==========================================
  // Hook Date.now()
  // ==========================================
  if (typeof Date.now === 'function') {
    originalDateNow = Date.now.bind(Date);
    const origDateNow = originalDateNow;

    const hookedDateNow = function now(): number {
      const real = origDateNow();
      // Date.now返回整数ms，jitter也取整
      const jittered = real + Math.round(generateJitter());

      // 确保单调递增
      if (jittered <= lastDateValue) {
        lastDateValue += 1;
      } else {
        lastDateValue = jittered;
      }

      return lastDateValue;
    };

    // 伪装函数特征
    originalDefineProperty.call(Object, hookedDateNow, 'name', {
      value: 'now',
      writable: false,
      enumerable: false,
      configurable: true,
    });

    originalDefineProperty.call(Object, hookedDateNow, 'length', {
      value: 0,
      writable: false,
      enumerable: false,
      configurable: true,
    });

    originalDefineProperty.call(Object, hookedDateNow, 'toString', {
      value: function () {
        return 'function now() { [native code] }';
      },
      writable: true,
      enumerable: false,
      configurable: true,
    });

    originalDefineProperty.call(Object, Date, 'now', {
      value: hookedDateNow,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }
}

/**
 * 获取原始的performance.now（供内部模块使用，绕过jitter）
 * @returns 原始performance.now函数，若未安装则返回当前performance.now
 */
export function getOriginalPerformanceNow(): () => number {
  if (originalPerformanceNow) return originalPerformanceNow;
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now.bind(performance);
  }
  return () => Date.now();
}

/**
 * 获取原始的Date.now（供内部模块使用，绕过jitter）
 * @returns 原始Date.now函数，若未安装则返回当前Date.now
 */
export function getOriginalDateNow(): () => number {
  if (originalDateNow) return originalDateNow;
  return Date.now.bind(Date);
}
