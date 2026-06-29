/**
 * Stealth Bootstrap - 隐蔽初始化（注入到页面主世界的第一步）
 *
 * 必须在页面任何JS执行之前同步完成：
 * 1. 隐藏Extension存在痕迹
 * 2. 修补 toString / getOwnPropertyDescriptor 检测
 * 3. 安装时序对齐防护
 * 4. 安装 Error.stack 帧清洗
 *
 * 所有操作同步执行（不能用async），确保在页面JS之前完成。
 */

import { hideExtension } from '@core/stealth/extension-hider';
import { ProxyHookEngine } from '@core/stealth/proxy-hook-engine';
import { installTimingShield } from '@core/stealth/timing-shield';
import { installStackCleaner } from '@core/stealth/stack-cleaner';

/** Stealth引擎的ProxyHookEngine实例（供vm-tracer等模块复用） */
export const stealthEngine = new ProxyHookEngine();

/**
 * 执行隐蔽初始化
 * 同步调用，无async，确保在页面任何脚本执行之前完成所有防护部署
 */
export function bootstrapStealth(): void {
  // Step 1: 隐藏Extension自身存在（chrome.runtime.id等）
  hideExtension();

  // Step 2: 初始化ProxyHookEngine（修补toString + descriptor + ownKeys）
  stealthEngine.init();

  // Step 3: 安装时序对齐防护（performance.now / Date.now jitter）
  installTimingShield();

  // Step 4: 安装Error.stack帧清洗（移除extension相关栈帧）
  installStackCleaner();
}
