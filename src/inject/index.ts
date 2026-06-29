/**
 * WebTrace Inject Script - 页面主世界入口
 *
 * 注入到页面的MAIN world，作为IIFE立即执行。
 * 执行顺序：
 * 1. 立即执行 stealth-bootstrap（隐蔽初始化）
 * 2. 初始化 vm-tracer（VM追踪器）
 * 3. 设置与 Content Script 的通信通道
 * 4. 通知Content Script注入完成
 * 5. 清理自身痕迹（移除注入script标签）
 */

import { bootstrapStealth } from './stealth-bootstrap';
import { initVMTracer } from './vm-tracer';
import { MESSAGE_PREFIX } from '@shared/constants';

// ─── Step 1: 立即执行隐蔽初始化（同步，最高优先级） ───
bootstrapStealth();

// ─── Step 2: 初始化VM追踪器 ───
initVMTracer();

// ─── Step 3: 设置与Content Script的通信通道 ───

/**
 * 监听来自Content Script的消息（通过window.postMessage转发）
 * Content Script会将Background的响应通过postMessage回传
 */
window.addEventListener('message', (event: MessageEvent) => {
  // 仅接受来自同一窗口的消息
  if (event.source !== window) return;

  const data = event.data;
  if (!data || data.__wt !== true) return;

  // 处理来自Content Script回传的消息（如HOOK_SETUP指令）
  if (data.type === 'HOOK_SETUP') {
    // 后续Task实现：动态Hook配置
    // 根据payload配置新的Hook目标
  }
});

// ─── Step 4: 通知Content Script注入已完成 ───
window.postMessage(
  {
    __wt: true,
    id: `${MESSAGE_PREFIX}_inject_${Date.now()}`,
    type: 'INJECT_READY',
    payload: {
      timestamp: Date.now(),
      url: location.href,
    },
  },
  '*'
);

// ─── Step 5: 清理自身痕迹 ───

/**
 * 移除注入自身的script标签
 * 使用微任务延迟确保当前脚本执行完毕后再清理
 */
Promise.resolve().then(() => {
  try {
    // 查找通过chrome.scripting.executeScript注入的脚本或内联脚本
    const currentScript = document.currentScript;
    if (currentScript && currentScript.parentNode) {
      currentScript.parentNode.removeChild(currentScript);
    }
  } catch {
    // 静默处理：某些注入方式下currentScript为null
  }
});
