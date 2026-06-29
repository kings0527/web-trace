/**
 * JSVMP Executor - 在QuickJS沙箱中执行JSVMP代码并追踪
 *
 * 两种模式：
 *
 * 模式A - 离线沙箱执行：
 *   输入：JSVMP源代码（含VM解释器+字节码）
 *   过程：在QuickJS中执行，通过注入的__vmTrace回调收集指令流
 *   输出：完整的(PC, opcode, stack)三元组序列
 *
 * 模式B - 页面增强分析：
 *   输入：从页面提取的字节码数组 + 已插桩的VM代码
 *   过程：在QuickJS中模拟执行字节码部分
 *   输出：操作码语义分析结果
 */

import type { SandboxConfig, TraceEntry } from '@shared/types';
import { executeCode, type ExecutionResult } from './sandbox';
import { TraceCollector, type TraceFilter } from './trace-collector';

// ─── Types ───

export interface ExecutorOptions {
  /** 沙箱配置覆盖 */
  sandboxConfig?: Partial<SandboxConfig>;
  /** 是否启用trace收集 */
  traceEnabled?: boolean;
  /** trace过滤器 */
  traceFilter?: TraceFilter;
  /** 最大trace条目数（防止内存溢出） */
  maxTraceEntries?: number;
  /** 自定义环境变量注入 */
  globals?: Record<string, unknown>;
  /** 执行前注入的插桩代码 */
  instrumentationCode?: string;
}

export interface TraceResult {
  /** 执行是否成功 */
  success: boolean;
  /** 收集到的trace条目 */
  traces: TraceEntry[];
  /** 执行结果值 */
  returnValue?: unknown;
  /** 错误信息 */
  error?: string;
  /** 执行耗时(ms) */
  executionTime: number;
  /** 统计信息 */
  stats: {
    totalOpcodes: number;
    uniqueOpcodes: number;
    opcodeFrequency: Map<number, number>;
    maxStackDepth: number;
    pcRange: [number, number];
  };
}

export interface OpcodeAnalysis {
  /** 操作码总数 */
  totalOpcodes: number;
  /** 已识别的操作码语义 */
  opcodeSemantics: OpcodeSemanticEntry[];
  /** 控制流图边（pc -> [target_pc]） */
  controlFlowEdges: Map<number, number[]>;
  /** 函数调用点 */
  callSites: CallSiteInfo[];
  /** 分析置信度 */
  confidence: number;
}

export interface OpcodeSemanticEntry {
  opcode: number;
  mnemonic: string;
  category: 'arithmetic' | 'comparison' | 'control' | 'stack' | 'memory' | 'call' | 'unknown';
  operandCount: number;
  description: string;
}

export interface CallSiteInfo {
  pc: number;
  opcode: number;
  targetName?: string;
  argCount?: number;
}

type TraceCallback = (entry: TraceEntry) => void;

// ─── JSVMP Executor Class ───

export class JSVMPExecutor {
  private collector: TraceCollector;
  private traceCallback: TraceCallback | null = null;
  private disposed = false;

  constructor() {
    this.collector = new TraceCollector();
  }

  // ─── Public API ───

  /**
   * 模式A：在QuickJS沙箱中执行JSVMP源代码并收集trace
   *
   * @param code JSVMP源代码（包含VM解释器+字节码数据）
   * @param options 执行选项
   * @returns 包含完整trace数据的执行结果
   */
  async executeJSVMP(code: string, options?: ExecutorOptions): Promise<TraceResult> {
    if (this.disposed) {
      throw new Error('[JSVMPExecutor] Already disposed');
    }

    const startTime = performance.now();
    const opts = options || {};

    // 设置trace过滤器
    if (opts.traceFilter) {
      this.collector.setFilter(opts.traceFilter);
    }

    // 注册收集器的flush回调，转发给外部callback
    if (this.traceCallback) {
      const cb = this.traceCallback;
      this.collector.onFlush((entries) => {
        for (const entry of entries) {
          cb(entry);
        }
      });
    }

    // 构造增强代码：注入trace桩 + 环境变量 + 原始代码
    const augmentedCode = this.buildAugmentedCode(code, opts);

    // 执行
    const sandboxConfig: Partial<SandboxConfig> = {
      traceEnabled: opts.traceEnabled !== false,
      ...opts.sandboxConfig,
    };

    const execResult: ExecutionResult = await executeCode(augmentedCode, sandboxConfig);

    // 合并trace：sandbox内部收集的 + collector中的
    const allTraces = [
      ...(execResult.traceEntries || []),
      ...this.collector.flush(),
    ];

    // 如果有最大条目限制，裁剪
    const maxEntries = opts.maxTraceEntries || Infinity;
    const traces = allTraces.length > maxEntries
      ? allTraces.slice(0, maxEntries)
      : allTraces;

    // 向外部回调推送
    if (this.traceCallback) {
      for (const entry of traces) {
        this.traceCallback(entry);
      }
    }

    // 计算统计信息
    const stats = this.computeStats(traces);

    return {
      success: execResult.success,
      traces,
      returnValue: execResult.value,
      error: execResult.error,
      executionTime: performance.now() - startTime,
      stats,
    };
  }

  /**
   * 模式B：分析字节码操作码语义
   *
   * @param bytecode 从页面提取的字节码数组
   * @param dispatcherCode 已插桩的VM解释器代码（包含switch-case）
   * @returns 操作码语义分析结果
   */
  async analyzeOpcodes(bytecode: number[], dispatcherCode: string): Promise<OpcodeAnalysis> {
    if (this.disposed) {
      throw new Error('[JSVMPExecutor] Already disposed');
    }

    // 构造分析代码：模拟执行每个opcode，记录行为
    const analysisCode = this.buildAnalysisCode(bytecode, dispatcherCode);

    const execResult = await executeCode(analysisCode, {
      traceEnabled: true,
      maxExecutionTime: 10000, // 分析10s超时
    });

    // 解析分析结果
    const traceData = execResult.traceEntries || [];
    const semantics = this.inferOpcodeSemantics(traceData, bytecode);
    const controlFlow = this.buildControlFlowGraph(traceData);
    const callSites = this.extractCallSites(traceData);

    return {
      totalOpcodes: new Set(bytecode).size,
      opcodeSemantics: semantics,
      controlFlowEdges: controlFlow,
      callSites,
      confidence: this.calculateConfidence(semantics, bytecode),
    };
  }

  /**
   * 设置外部trace回调
   * 每收集到一条trace时触发
   */
  setTraceCallback(cb: TraceCallback): void {
    this.traceCallback = cb;
  }

  /**
   * 获取内部collector引用（用于外部控制flush等）
   */
  getCollector(): TraceCollector {
    return this.collector;
  }

  /**
   * 释放资源
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.collector.dispose();
    this.traceCallback = null;
  }

  // ─── Private: Code Generation ───

  /**
   * 构造增强代码：包裹原始JSVMP代码，注入trace桩
   */
  private buildAugmentedCode(code: string, opts: ExecutorOptions): string {
    const parts: string[] = [];

    // 1. 注入全局变量
    if (opts.globals) {
      for (const [key, value] of Object.entries(opts.globals)) {
        parts.push(`var ${key} = ${JSON.stringify(value)};`);
      }
    }

    // 2. 注入trace桩辅助函数（如果__vmTrace不可用，提供桥接）
    parts.push(`
// __vmTrace bridge: ensure the trace function exists
if (typeof __vmTrace === 'undefined') {
  var __traceBuffer = [];
  var __vmTrace = function(pc, opcode, stackJson) {
    __traceBuffer.push({ pc: pc, opcode: opcode, stack: stackJson });
  };
}
`);

    // 3. 注入自定义插桩代码
    if (opts.instrumentationCode) {
      parts.push(opts.instrumentationCode);
    }

    // 4. 原始代码
    parts.push(code);

    // 5. 返回trace buffer（如果有的话）
    parts.push(`
// Return collected trace data
(typeof __traceBuffer !== 'undefined') ? JSON.stringify(__traceBuffer) : undefined;
`);

    return parts.join('\n');
  }

  /**
   * 构造字节码分析代码
   * 创建一个精简的模拟执行环境，逐个执行opcode观察副作用
   */
  private buildAnalysisCode(bytecode: number[], dispatcherCode: string): string {
    return `
// Bytecode analysis mode
var __bytecode = ${JSON.stringify(bytecode)};
var __pc = 0;
var __stack = [];
var __maxSteps = ${Math.min(bytecode.length * 2, 50000)};
var __steps = 0;

// Wrap dispatcher in a controlled execution loop
(function() {
  ${dispatcherCode}

  // If the dispatcher defines a known entry point, call it
  if (typeof __vmMain === 'function') {
    __vmMain(__bytecode);
  } else if (typeof interpret === 'function') {
    interpret(__bytecode);
  } else if (typeof run === 'function') {
    run(__bytecode);
  }
})();

// Return analysis data
JSON.stringify({
  stepsExecuted: __steps,
  finalPC: __pc,
  stackSize: __stack.length
});
`;
  }

  // ─── Private: Analysis Helpers ───

  /**
   * 根据trace数据推断opcode语义
   */
  private inferOpcodeSemantics(traces: TraceEntry[], bytecode: number[]): OpcodeSemanticEntry[] {
    const uniqueOpcodes = [...new Set(bytecode)];
    const semantics: OpcodeSemanticEntry[] = [];

    // 按opcode分组trace条目，分析stack变化推断语义
    const opcodeTraces = new Map<number, TraceEntry[]>();
    for (const trace of traces) {
      const arr = opcodeTraces.get(trace.opcode) || [];
      arr.push(trace);
      opcodeTraces.set(trace.opcode, arr);
    }

    for (const opcode of uniqueOpcodes) {
      const entries = opcodeTraces.get(opcode) || [];
      const semantic = this.classifyOpcode(opcode, entries);
      semantics.push(semantic);
    }

    return semantics;
  }

  /**
   * 根据opcode的执行痕迹分类
   */
  private classifyOpcode(opcode: number, entries: TraceEntry[]): OpcodeSemanticEntry {
    if (entries.length === 0) {
      return {
        opcode,
        mnemonic: `OP_${opcode.toString(16).toUpperCase().padStart(2, '0')}`,
        category: 'unknown',
        operandCount: 0,
        description: 'No execution data available',
      };
    }

    // 分析stack变化模式
    let category: OpcodeSemanticEntry['category'] = 'unknown';
    let operandCount = 0;
    let description = '';

    // 简单启发式：根据栈深度变化分类
    const stackDepths = entries.map(e => e.stackSnapshot.length);
    const avgDepthChange = stackDepths.length > 1
      ? (stackDepths[stackDepths.length - 1] - stackDepths[0]) / stackDepths.length
      : 0;

    // PC跳跃检测（控制流）
    const pcs = entries.map(e => e.pc);
    const hasJumps = pcs.some((pc, i) => i > 0 && Math.abs(pc - pcs[i - 1]) > 2);

    if (hasJumps) {
      category = 'control';
      description = 'Control flow instruction (jump/branch)';
    } else if (avgDepthChange > 0.5) {
      category = 'stack';
      operandCount = 0;
      description = 'Stack push operation';
    } else if (avgDepthChange < -0.5) {
      category = 'arithmetic';
      operandCount = 2;
      description = 'Consumes stack values (likely arithmetic/comparison)';
    } else {
      category = 'memory';
      description = 'Memory or variable access';
    }

    return {
      opcode,
      mnemonic: `OP_${opcode.toString(16).toUpperCase().padStart(2, '0')}`,
      category,
      operandCount,
      description,
    };
  }

  /**
   * 从trace数据构建控制流图
   */
  private buildControlFlowGraph(traces: TraceEntry[]): Map<number, number[]> {
    const edges = new Map<number, number[]>();

    for (let i = 1; i < traces.length; i++) {
      const from = traces[i - 1].pc;
      const to = traces[i].pc;

      // 非顺序跳转视为控制流边
      if (Math.abs(to - from) > 1) {
        const targets = edges.get(from) || [];
        if (!targets.includes(to)) {
          targets.push(to);
        }
        edges.set(from, targets);
      }
    }

    return edges;
  }

  /**
   * 从trace数据提取函数调用点
   */
  private extractCallSites(traces: TraceEntry[]): CallSiteInfo[] {
    const callSites: CallSiteInfo[] = [];

    for (const trace of traces) {
      // 启发式：如果stackSnapshot中包含function引用，可能是call指令
      const stack = trace.stackSnapshot;
      if (stack.some(item => typeof item === 'function' || (typeof item === 'string' && item.includes('function')))) {
        callSites.push({
          pc: trace.pc,
          opcode: trace.opcode,
          targetName: this.extractFunctionName(stack),
          argCount: this.inferArgCount(stack),
        });
      }
    }

    return callSites;
  }

  /**
   * 从栈快照提取函数名
   */
  private extractFunctionName(stack: unknown[]): string | undefined {
    for (const item of stack) {
      if (typeof item === 'string') {
        const match = item.match(/function\s+(\w+)/);
        if (match) return match[1];
      }
    }
    return undefined;
  }

  /**
   * 推断函数参数个数
   */
  private inferArgCount(stack: unknown[]): number {
    // 简单启发式：函数引用之后的栈元素视为参数
    const fnIdx = stack.findIndex(item =>
      typeof item === 'function' || (typeof item === 'string' && item.includes('function'))
    );
    return fnIdx >= 0 ? stack.length - fnIdx - 1 : 0;
  }

  /**
   * 计算分析置信度
   */
  private calculateConfidence(semantics: OpcodeSemanticEntry[], bytecode: number[]): number {
    if (semantics.length === 0 || bytecode.length === 0) return 0;

    const identified = semantics.filter(s => s.category !== 'unknown').length;
    const total = semantics.length;
    return Math.round((identified / total) * 100) / 100;
  }

  /**
   * 计算trace统计信息
   */
  private computeStats(traces: TraceEntry[]) {
    const opcodeFrequency = new Map<number, number>();
    let maxStackDepth = 0;
    let minPC = Infinity;
    let maxPC = -Infinity;

    for (const trace of traces) {
      // 频率统计
      opcodeFrequency.set(trace.opcode, (opcodeFrequency.get(trace.opcode) || 0) + 1);
      // 栈深度
      maxStackDepth = Math.max(maxStackDepth, trace.stackSnapshot.length);
      // PC范围
      minPC = Math.min(minPC, trace.pc);
      maxPC = Math.max(maxPC, trace.pc);
    }

    return {
      totalOpcodes: traces.length,
      uniqueOpcodes: opcodeFrequency.size,
      opcodeFrequency,
      maxStackDepth,
      pcRange: [
        minPC === Infinity ? 0 : minPC,
        maxPC === -Infinity ? 0 : maxPC,
      ] as [number, number],
    };
  }
}
