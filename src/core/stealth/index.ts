/**
 * WebTrace Stealth Engine - 三层隐蔽引擎
 *
 * 模块导出：
 * - ProxyHookEngine: 通用Proxy Hook框架（基础层）
 * - hideExtension: Extension存在隐藏
 * - installTimingShield: 时序对齐防护
 * - installStackCleaner: Error.stack帧清洗
 */

export { ProxyHookEngine, proxyHookEngine } from './proxy-hook-engine';
export type { HookHandler } from './proxy-hook-engine';
export { hideExtension } from './extension-hider';
export {
  installTimingShield,
  getOriginalPerformanceNow,
  getOriginalDateNow,
} from './timing-shield';
export { installStackCleaner } from './stack-cleaner';
