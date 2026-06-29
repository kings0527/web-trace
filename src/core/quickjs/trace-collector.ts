/**
 * Trace Collector - 高性能trace数据收集
 * 使用 Ring Buffer 避免内存无限增长
 */

import { TRACE_BUFFER_SIZE, TRACE_FLUSH_INTERVAL, TRACE_FLUSH_THRESHOLD } from '@shared/constants';
import type { TraceEntry } from '@shared/types';

// ─── Types ───

export interface TraceFilter {
  /** 仅收集此opcode范围内的trace */
  opcodeRange?: [number, number];
  /** 仅收集特定函数名相关的trace */
  functionNames?: string[];
  /** 自定义过滤谓词 */
  predicate?: (entry: TraceEntry) => boolean;
}

export interface CollectorStats {
  /** 总共push的条目数 */
  totalPushed: number;
  /** 因buffer满被覆盖（丢弃）的条目数 */
  totalDropped: number;
  /** flush次数 */
  flushCount: number;
  /** 当前buffer中的有效条目数 */
  currentSize: number;
  /** buffer容量 */
  capacity: number;
}

type FlushCallback = (entries: TraceEntry[]) => void;

// ─── Implementation ───

export class TraceCollector {
  /** 预分配的固定容量数组 */
  private buffer: (TraceEntry | null)[];
  /** 下一次写入位置 */
  private writeIndex: number = 0;
  /** 当前有效条目数（未达到满之前递增，满后恒等于capacity） */
  private count: number = 0;
  /** 容量 */
  private readonly capacity: number;

  /** flush定时器 */
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  /** flush阈值（条目数） */
  private readonly flushThreshold: number;

  /** flush回调列表 */
  private flushCallbacks: FlushCallback[] = [];

  /** 当前过滤器 */
  private filter: TraceFilter | null = null;

  /** 统计数据 */
  private stats: CollectorStats;

  /** 是否已销毁 */
  private disposed: boolean = false;

  constructor(capacity: number = TRACE_BUFFER_SIZE) {
    this.capacity = capacity;
    // 预分配数组空间，填充null
    this.buffer = new Array<TraceEntry | null>(capacity).fill(null);
    this.flushThreshold = Math.floor(capacity * TRACE_FLUSH_THRESHOLD);

    this.stats = {
      totalPushed: 0,
      totalDropped: 0,
      flushCount: 0,
      currentSize: 0,
      capacity,
    };

    // 启动定时flush
    this.startFlushTimer();
  }

  // ─── Public API ───

  /**
   * 推入一条trace记录
   * 如果不符合过滤条件则直接丢弃（不计入统计）
   * 如果buffer满则覆盖最老的数据（计入dropped）
   */
  push(entry: TraceEntry): void {
    if (this.disposed) return;

    // 应用过滤器
    if (this.filter && !this.matchesFilter(entry)) {
      return;
    }

    // 写入ring buffer
    if (this.count >= this.capacity) {
      // buffer已满，覆盖最老数据
      this.stats.totalDropped++;
    } else {
      this.count++;
    }

    this.buffer[this.writeIndex] = entry;
    this.writeIndex = (this.writeIndex + 1) % this.capacity;
    this.stats.totalPushed++;
    this.stats.currentSize = this.count;

    // 检查是否达到flush阈值
    if (this.count >= this.flushThreshold && this.flushCallbacks.length > 0) {
      this.performFlush();
    }
  }

  /**
   * 手动flush：取出所有有效数据，清空buffer
   * 返回按写入顺序排列的条目数组
   */
  flush(): TraceEntry[] {
    if (this.disposed || this.count === 0) return [];

    const entries = this.drainBuffer();
    this.notifyCallbacks(entries);
    return entries;
  }

  /**
   * 设置trace过滤器
   * 设为null取消过滤
   */
  setFilter(filter: TraceFilter | null): void {
    this.filter = filter;
  }

  /**
   * 注册flush回调
   * 当自动flush触发时，数据会通过回调发送
   */
  onFlush(callback: FlushCallback): void {
    this.flushCallbacks.push(callback);
  }

  /**
   * 获取收集器统计信息
   */
  getStats(): CollectorStats {
    return { ...this.stats, currentSize: this.count };
  }

  /**
   * 清空buffer和统计
   */
  clear(): void {
    this.buffer.fill(null);
    this.writeIndex = 0;
    this.count = 0;
    this.stats.currentSize = 0;
  }

  /**
   * 销毁收集器，释放资源
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopFlushTimer();
    this.flushCallbacks = [];
    this.buffer = [];
    this.count = 0;
  }

  // ─── Private Methods ───

  /**
   * 检查entry是否匹配当前过滤器
   */
  private matchesFilter(entry: TraceEntry): boolean {
    if (!this.filter) return true;

    const { opcodeRange, functionNames, predicate } = this.filter;

    // opcode范围过滤
    if (opcodeRange) {
      const [min, max] = opcodeRange;
      if (entry.opcode < min || entry.opcode > max) return false;
    }

    // 函数名过滤（检查stackSnapshot中是否包含指定函数名）
    if (functionNames && functionNames.length > 0) {
      const stackStr = JSON.stringify(entry.stackSnapshot);
      const matched = functionNames.some(name => stackStr.includes(name));
      if (!matched) return false;
    }

    // 自定义谓词
    if (predicate && !predicate(entry)) return false;

    return true;
  }

  /**
   * 从ring buffer中按顺序取出所有有效数据
   */
  private drainBuffer(): TraceEntry[] {
    const entries: TraceEntry[] = [];

    if (this.count === 0) return entries;

    // 计算读取起始位置：
    // 如果buffer未满，起始位置为0
    // 如果buffer已满，起始位置为当前writeIndex（即最老的数据）
    const startIndex = this.count < this.capacity
      ? 0
      : this.writeIndex;

    for (let i = 0; i < this.count; i++) {
      const idx = (startIndex + i) % this.capacity;
      const entry = this.buffer[idx];
      if (entry !== null) {
        entries.push(entry);
        this.buffer[idx] = null;
      }
    }

    // 重置状态
    this.writeIndex = 0;
    this.count = 0;
    this.stats.currentSize = 0;

    return entries;
  }

  /**
   * 执行flush操作
   */
  private performFlush(): void {
    if (this.count === 0) return;

    const entries = this.drainBuffer();
    this.stats.flushCount++;
    this.notifyCallbacks(entries);
  }

  /**
   * 通知所有flush回调
   */
  private notifyCallbacks(entries: TraceEntry[]): void {
    if (entries.length === 0) return;
    for (const cb of this.flushCallbacks) {
      try {
        cb(entries);
      } catch (err) {
        console.error('[TraceCollector] Flush callback error:', err);
      }
    }
  }

  /**
   * 启动定时flush
   */
  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => {
      if (this.count > 0 && this.flushCallbacks.length > 0) {
        this.performFlush();
      }
    }, TRACE_FLUSH_INTERVAL);
  }

  /**
   * 停止定时flush
   */
  private stopFlushTimer(): void {
    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }
}
