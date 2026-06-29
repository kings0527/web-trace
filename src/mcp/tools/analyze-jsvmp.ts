/**
 * MCP Tool: analyze_jsvmp
 *
 * 分析JSVMP代码结构，识别VM派发循环，返回结构化的分析结果。
 * 可选先进行反混淆预处理以提高分析准确度。
 */

import { z } from 'zod';
import { detectVMDispatchers, deobfuscate } from '@core/babel';
import type { VMDispatcherInfo } from '@shared/types';

// ─── Schema 定义 ───

export const analyzeJsvmpInputSchema = {
  code: z.string().min(1).describe(
    'JSVMP代码字符串，可以是混淆后的原始代码。',
  ),
  deobfuscate: z.boolean().optional().default(false).describe(
    '是否在分析前先执行反混淆预处理。开启可提高检测准确度但会增加处理时间。',
  ),
};

// ─── Tool 元数据 ───

export const analyzeJsvmpMeta = {
  name: 'analyze_jsvmp',
  description: `分析JSVMP(JavaScript Virtual Machine Protection)代码结构。

功能：
- 识别VM派发循环（while-switch、while-if-else、handler-table模式）
- 提取字节码数组变量名和PC计数器变量名
- 统计opcode数量和case分支数
- 可选反混淆预处理提高准确度

输入代码可以是混淆后的原始JS代码。工具会自动使用AST分析识别VM模式。
返回所有检测到的派发器结构信息。`,
};

// ─── Handler ───

export interface AnalyzeJsvmpInput {
  code: string;
  deobfuscate?: boolean;
}

export interface AnalyzeJsvmpOutput {
  dispatchers: SerializedDispatcherInfo[];
  opcodeCount: number;
  structure: {
    totalFunctions: number;
    largestDispatcher: number;
    patterns: string[];
  };
}

/** 序列化版本的 VMDispatcherInfo（Map → Record） */
interface SerializedDispatcherInfo {
  type: VMDispatcherInfo['type'];
  location: { line: number; column: number };
  bytecodeArrayName: string;
  pcVariableName: string;
  opcodeCount: number;
  cases: Record<string, string>;
}

function serializeDispatcher(info: VMDispatcherInfo): SerializedDispatcherInfo {
  const cases: Record<string, string> = {};
  for (const [opcode, label] of info.cases) {
    cases[String(opcode)] = label;
  }
  return {
    type: info.type,
    location: info.location,
    bytecodeArrayName: info.bytecodeArrayName,
    pcVariableName: info.pcVariableName,
    opcodeCount: info.opcodeCount,
    cases,
  };
}

/**
 * analyze_jsvmp 工具执行函数
 */
export async function handleAnalyzeJsvmp(
  args: AnalyzeJsvmpInput,
): Promise<AnalyzeJsvmpOutput> {
  let codeToAnalyze = args.code;

  // Step 1: 可选反混淆预处理
  if (args.deobfuscate) {
    try {
      const deobResult = deobfuscate(codeToAnalyze);
      codeToAnalyze = deobResult.code;
    } catch (err) {
      // 反混淆失败不阻塞分析，使用原始代码继续
      console.warn('[analyze_jsvmp] Deobfuscation failed, using original code:', err);
    }
  }

  // Step 2: 使用 vm-pattern-detector 识别派发循环
  const dispatchers = detectVMDispatchers(codeToAnalyze);

  // Step 3: 构造结果
  const serializedDispatchers = dispatchers.map(serializeDispatcher);

  // 统计总 opcode 数
  const totalOpcodes = dispatchers.reduce((sum, d) => sum + d.opcodeCount, 0);

  // 找最大派发器
  const largestDispatcher = dispatchers.reduce(
    (max, d) => Math.max(max, d.opcodeCount),
    0,
  );

  // 提取模式类型
  const patterns = [...new Set(dispatchers.map((d) => d.type))];

  // 统计函数数量（简单启发式）
  const funcMatches = codeToAnalyze.match(/function\s*[\w$]*\s*\(/g);
  const arrowMatches = codeToAnalyze.match(/=>\s*[{(]/g);
  const totalFunctions = (funcMatches?.length || 0) + (arrowMatches?.length || 0);

  return {
    dispatchers: serializedDispatchers,
    opcodeCount: totalOpcodes,
    structure: {
      totalFunctions,
      largestDispatcher,
      patterns,
    },
  };
}
