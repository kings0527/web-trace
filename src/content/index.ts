/**
 * WebTrace Content Script - 消息桥接层
 *
 * 运行在隔离世界（Isolated World），职责：
 * 1. 作为页面主世界(inject) ↔ Service Worker(background)的消息桥接
 * 2. 监听window message事件，过滤__wt标记的消息
 * 3. 将消息转发到Service Worker
 * 4. 监听Service Worker响应，通过postMessage回传到页面
 * 5. 在document_start时通知background执行注入
 *
 * 通信路径：
 * inject(MAIN world) --postMessage--> content(ISOLATED) --chrome.runtime--> background(SW)
 * background(SW) --response--> content(ISOLATED) --postMessage--> inject(MAIN world)
 */

import { isWebTraceMessage, createMessage } from '@shared/message-protocol';
import type { InternalMessage } from '@shared/types';

// ─── 消息桥接：页面主世界 → Service Worker ───

/**
 * 监听来自inject脚本的window.postMessage
 * 过滤__wt标记的消息并转发到background
 */
window.addEventListener('message', (event: MessageEvent) => {
  // 仅接受来自同一窗口的消息
  if (event.source !== window) return;

  const data = event.data;

  // 验证是否为WebTrace内部消息
  if (!isWebTraceMessage(data)) return;

  const message = data as InternalMessage;

  // 转发到Service Worker
  chrome.runtime.sendMessage(message).then((response) => {
    // 将background的响应回传到页面主世界
    if (response !== undefined) {
      window.postMessage(
        {
          __wt: true,
          id: `${message.id}_response`,
          type: message.type,
          payload: response,
          _isResponse: true,
        },
        '*'
      );
    }
  }).catch((err) => {
    // Service Worker可能不可用（如extension被禁用）
    console.debug('[WebTrace CS] Failed to forward message:', err);
  });
});

// ─── 消息桥接：Service Worker → 页面主世界 ───

/**
 * 监听来自Service Worker的主动推送消息
 * （如MCP Tool触发的HOOK_SETUP指令）
 */
chrome.runtime.onMessage.addListener(
  (message: unknown, _sender: chrome.runtime.MessageSender, sendResponse) => {
    if (!isWebTraceMessage(message)) return false;

    const msg = message as InternalMessage;

    // 将background推送的消息转发到页面主世界
    window.postMessage(msg, '*');

    // 确认收到
    sendResponse({ received: true });
    return false;
  }
);

// ─── 触发注入：通知background将inject脚本注入到MAIN world ───

/**
 * Content Script在document_start时加载
 * 立即通知background执行chrome.scripting.executeScript注入
 * （content_scripts无法直接调用chrome.scripting API）
 */
function requestInjection(): void {
  const message = createMessage('REQUEST_INJECT', {
    url: location.href,
    frameId: 0, // 主frame，subframe由all_frames处理
  });

  chrome.runtime.sendMessage(message).catch((err) => {
    // 首次加载时SW可能还没就绪，延迟重试一次
    console.debug('[WebTrace CS] Inject request failed, retrying...', err);
    setTimeout(() => {
      chrome.runtime.sendMessage(message).catch(() => {
        // 静默处理：SW确实不可用
      });
    }, 100);
  });
}

// 立即请求注入（document_start时执行）
requestInjection();
