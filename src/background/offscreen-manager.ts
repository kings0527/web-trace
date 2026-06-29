/**
 * Offscreen Manager - Offscreen Document生命周期管理
 * 解决Manifest V3 Service Worker 30s超时问题
 *
 * 职责：
 * 1. 创建/维护Offscreen Document
 * 2. 心跳检测确保offscreen存活
 * 3. 异常关闭时自动重建
 * 4. 任务路由与结果回收
 */

import { OFFSCREEN_HEARTBEAT_INTERVAL } from '@shared/constants';
import type { OffscreenMessage, OffscreenMessageType } from '@shared/types';
import { generateId } from '@shared/message-protocol';

const OFFSCREEN_URL = 'src/offscreen/index.html';

/** 心跳超时阈值（若心跳在此时间内未响应则认为offscreen已死） */
const HEARTBEAT_TIMEOUT = OFFSCREEN_HEARTBEAT_INTERVAL * 2;

/** 最大重建尝试次数（避免无限循环） */
const MAX_RECREATE_ATTEMPTS = 3;

/** 重建冷却时间 */
const RECREATE_COOLDOWN = 2000; // 2s

interface PendingTask {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class OffscreenManager {
  private isAlive = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pendingTasks: Map<string, PendingTask> = new Map();
  private lastHeartbeatResponse = 0;
  private recreateAttempts = 0;
  private creating = false;

  /**
   * 初始化Offscreen Document并启动心跳
   */
  async initialize(): Promise<void> {
    try {
      await this.ensureOffscreenAlive();
      this.startHeartbeat();
      this.setupMessageListener();
      console.log('[OffscreenManager] Initialized successfully');
    } catch (err) {
      console.error('[OffscreenManager] Initialization failed:', err);
      throw err;
    }
  }

  /**
   * 发送任务到Offscreen Document并等待结果
   * @param type 任务类型
   * @param payload 任务数据
   * @param timeout 超时时间（默认30s）
   */
  async sendTask(type: OffscreenMessageType, payload: unknown, timeout = 30000): Promise<unknown> {
    // 确保offscreen存活
    await this.ensureOffscreenAlive();

    const id = generateId();
    const message: OffscreenMessage = {
      __wt: true,
      id,
      type,
      payload,
    };

    return new Promise((resolve, reject) => {
      // 设置超时计时器
      const timer = setTimeout(() => {
        this.pendingTasks.delete(id);
        reject(new Error(`[OffscreenManager] Task ${type} timed out after ${timeout}ms`));
      }, timeout);

      this.pendingTasks.set(id, { resolve, reject, timer });

      // 通过chrome.runtime.sendMessage发送到offscreen
      chrome.runtime.sendMessage(message).catch((err) => {
        this.pendingTasks.delete(id);
        clearTimeout(timer);
        reject(new Error(`[OffscreenManager] Failed to send task: ${err.message}`));
      });
    });
  }

  /**
   * 销毁管理器，清理所有资源
   */
  destroy(): void {
    this.stopHeartbeat();
    // 拒绝所有待处理任务
    for (const [id, task] of this.pendingTasks) {
      clearTimeout(task.timer);
      task.reject(new Error('[OffscreenManager] Manager destroyed'));
      this.pendingTasks.delete(id);
    }
    this.isAlive = false;
  }

  /**
   * 启动心跳定时器
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.lastHeartbeatResponse = Date.now();

    this.heartbeatTimer = setInterval(async () => {
      try {
        // 检查上次心跳响应是否超时
        const elapsed = Date.now() - this.lastHeartbeatResponse;
        if (elapsed > HEARTBEAT_TIMEOUT) {
          console.warn('[OffscreenManager] Heartbeat timeout, attempting recreate...');
          this.isAlive = false;
          await this.recreateIfNeeded();
          return;
        }

        // 发送心跳
        const heartbeatMsg: OffscreenMessage = {
          __wt: true,
          id: generateId(),
          type: 'HEARTBEAT',
          payload: { timestamp: Date.now() },
        };
        await chrome.runtime.sendMessage(heartbeatMsg);
      } catch (err) {
        console.warn('[OffscreenManager] Heartbeat send failed:', err);
        this.isAlive = false;
        await this.recreateIfNeeded();
      }
    }, OFFSCREEN_HEARTBEAT_INTERVAL);
  }

  /**
   * 停止心跳定时器
   */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * 设置消息监听器，接收offscreen返回的结果
   */
  private setupMessageListener(): void {
    chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
      if (!this.isOffscreenMessage(message)) return false;

      const msg = message as OffscreenMessage;

      // 处理心跳响应
      if (msg.type === 'HEARTBEAT') {
        this.lastHeartbeatResponse = Date.now();
        this.isAlive = true;
        this.recreateAttempts = 0; // 重置重建计数
        return false;
      }

      // 处理任务结果
      if (msg.type === 'RESULT' || msg.type === 'ERROR') {
        const pending = this.pendingTasks.get(msg.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingTasks.delete(msg.id);

          if (msg.type === 'RESULT') {
            pending.resolve(msg.payload);
          } else {
            pending.reject(new Error(String(msg.payload)));
          }
        }
        return false;
      }

      sendResponse(undefined);
      return false;
    });
  }

  /**
   * 确保Offscreen Document存活，不存在则创建
   */
  private async ensureOffscreenAlive(): Promise<void> {
    if (this.isAlive && !this.creating) return;

    const hasDocument = await this.hasOffscreenDocument();
    if (hasDocument) {
      this.isAlive = true;
      return;
    }

    await this.createOffscreen();
  }

  /**
   * 创建Offscreen Document
   */
  private async createOffscreen(): Promise<void> {
    if (this.creating) return;
    this.creating = true;

    try {
      // 先检查是否已存在（防止并发创建）
      const exists = await this.hasOffscreenDocument();
      if (exists) {
        this.isAlive = true;
        return;
      }

      await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: [chrome.offscreen.Reason.WORKERS],
        justification: 'WASM execution and heavy computation for code analysis',
      });

      this.isAlive = true;
      this.lastHeartbeatResponse = Date.now();
      console.log('[OffscreenManager] Offscreen document created');
    } catch (err) {
      // 如果已经存在，不算错误
      if (String(err).includes('Only a single offscreen')) {
        this.isAlive = true;
        return;
      }
      console.error('[OffscreenManager] Failed to create offscreen document:', err);
      throw err;
    } finally {
      this.creating = false;
    }
  }

  /**
   * 检测Offscreen Document是否已存在
   */
  private async hasOffscreenDocument(): Promise<boolean> {
    // chrome.offscreen.hasDocument 可用于 MV3 117+
    try {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT as any],
      });
      return contexts.length > 0;
    } catch {
      // fallback: 尝试用 hasDocument API
      try {
        return await (chrome.offscreen as any).hasDocument();
      } catch {
        return false;
      }
    }
  }

  /**
   * 当offscreen意外关闭时尝试重建
   */
  private async recreateIfNeeded(): Promise<void> {
    if (this.creating) return;

    if (this.recreateAttempts >= MAX_RECREATE_ATTEMPTS) {
      console.error(
        `[OffscreenManager] Max recreate attempts (${MAX_RECREATE_ATTEMPTS}) reached, giving up`
      );
      // 重置计数，等待下次心跳周期再尝试
      setTimeout(() => {
        this.recreateAttempts = 0;
      }, RECREATE_COOLDOWN * 5);
      return;
    }

    this.recreateAttempts++;
    console.log(
      `[OffscreenManager] Recreating offscreen (attempt ${this.recreateAttempts}/${MAX_RECREATE_ATTEMPTS})`
    );

    // 等待冷却时间
    await new Promise((r) => setTimeout(r, RECREATE_COOLDOWN));

    try {
      // 先尝试关闭已有的（如果有的话）
      try {
        await chrome.offscreen.closeDocument();
      } catch {
        // 忽略关闭失败（可能已不存在）
      }

      await this.createOffscreen();
      this.lastHeartbeatResponse = Date.now();
      console.log('[OffscreenManager] Offscreen document recreated successfully');
    } catch (err) {
      console.error('[OffscreenManager] Failed to recreate offscreen:', err);
    }
  }

  /**
   * 类型守卫：检查消息是否为offscreen消息
   */
  private isOffscreenMessage(data: unknown): data is OffscreenMessage {
    return (
      typeof data === 'object' &&
      data !== null &&
      '__wt' in data &&
      (data as OffscreenMessage).__wt === true &&
      'id' in data &&
      'type' in data
    );
  }
}
