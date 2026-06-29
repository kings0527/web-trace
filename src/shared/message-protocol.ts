/**
 * WebTrace 内部消息协议
 * Content Script ↔ Service Worker ↔ Offscreen Document
 */

import type { InternalMessage, MessageType } from './types';
import { MESSAGE_PREFIX } from './constants';

let messageId = 0;

/**
 * 创建内部消息
 */
export function createMessage(type: MessageType, payload: unknown): InternalMessage {
  return {
    __wt: true,
    id: `${MESSAGE_PREFIX}_${Date.now()}_${++messageId}`,
    type,
    payload,
  };
}

/**
 * 验证是否为WebTrace内部消息
 */
export function isWebTraceMessage(data: unknown): data is InternalMessage {
  return (
    typeof data === 'object' &&
    data !== null &&
    '__wt' in data &&
    (data as InternalMessage).__wt === true
  );
}

/**
 * 发送消息到Service Worker（从Content Script调用）
 */
export function sendToBackground(message: InternalMessage): Promise<unknown> {
  return chrome.runtime.sendMessage(message);
}

/**
 * 发送消息到Offscreen Document（从Service Worker调用）
 */
export function sendToOffscreen(message: InternalMessage): void {
  chrome.runtime.sendMessage(message);
}

/**
 * 通过window.postMessage发送（页面主世界 → Content Script）
 */
export function postToContentScript(message: InternalMessage): void {
  window.postMessage(message, '*');
}

/**
 * 生成唯一ID
 */
export function generateId(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
