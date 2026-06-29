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
  chunkSize: z.number().int().min(10000).max(5000000).optional().describe(
    '分片大小（字符数）。当代码超过200KB时自动分片处理。默认200000。',
  ),
  timeout: z.number().int().min(5000).max(300000).optional().default(60000).describe(
    '分析超时时间（毫秒）。默认60秒。',
  ),
  focusFunction: z.string().optional().describe(
    '只分析指定函数名称附近的代码。可减少分析范围提高效率。',
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
  chunkSize?: number;
  timeout?: number;
  focusFunction?: string;
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
  const timeout = args.timeout ?? 60000;
  const chunkSize = args.chunkSize ?? 200000; // 200KB default

  // Step 0: focusFunction - 提取目标函数附近的代码
  if (args.focusFunction) {
    const focused = extractFocusedCode(codeToAnalyze, args.focusFunction, chunkSize);
    if (focused) {
      codeToAnalyze = focused;
    }
  }

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

  // Step 2: 分片处理（当代码超过200KB时）
  const allDispatchers: VMDispatcherInfo[] = [];

  if (codeToAnalyze.length > chunkSize) {
    // 分片分析
    const chunks = splitCodeIntoChunks(codeToAnalyze, chunkSize);
    const startTime = Date.now();

    for (const chunk of chunks) {
      if (Date.now() - startTime > timeout) {
        console.warn('[analyze_jsvmp] Timeout reached, returning partial results');
        break;
      }
      try {
        const dispatchers = detectVMDispatchers(chunk);
        allDispatchers.push(...dispatchers);
      } catch (err) {
        console.warn('[analyze_jsvmp] Chunk analysis failed:', err);
      }
    }
  } else {
    // 单次分析
    const dispatchers = detectVMDispatchers(codeToAnalyze);
    allDispatchers.push(...dispatchers);
  }

  // Step 3: 构造结果
  const serializedDispatchers = allDispatchers.map(serializeDispatcher);

  // 统计总 opcode 数
  const totalOpcodes = allDispatchers.reduce((sum, d) => sum + d.opcodeCount, 0);

  // 找最大派发器
  const largestDispatcher = allDispatchers.reduce(
    (max, d) => Math.max(max, d.opcodeCount),
    0,
  );

  // 提取模式类型
  const patterns = [...new Set(allDispatchers.map((d) => d.type))];

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

// ─── 辅助函数 ───

/**
 * 提取指定函数名附近的代码片段
 */
function extractFocusedCode(code: string, functionName: string, contextSize: number): string | null {
  // 尝试找到函数定义位置
  const patterns = [
    new RegExp(`function\\s+${escapeRegex(functionName)}\\s*\\(`, 'g'),
    new RegExp(`(?:var|let|const)\\s+${escapeRegex(functionName)}\\s*=`, 'g'),
    new RegExp(`['"]${escapeRegex(functionName)}['"]\\s*:`, 'g'),
    new RegExp(`\\.${escapeRegex(functionName)}\\s*=`, 'g'),
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(code);
    if (match) {
      const center = match.index;
      const halfContext = Math.floor(contextSize / 2);
      const start = Math.max(0, center - halfContext);
      const end = Math.min(code.length, center + halfContext);
      return code.slice(start, end);
    }
  }

  return null;
}

/**
 * 将大代码分片，尽量在函数边界处切分
 */
function splitCodeIntoChunks(code: string, chunkSize: number): string[] {
  const chunks: string[] = [];
  let offset = 0;

  while (offset < code.length) {
    let end = Math.min(offset + chunkSize, code.length);

    // 尝试在函数边界处切分（向前找最近的右花括号+换行）
    if (end < code.length) {
      const searchStart = Math.max(end - 1000, offset);
      const searchStr = code.slice(searchStart, end);
      const lastBrace = searchStr.lastIndexOf('}\n');
      if (lastBrace !== -1) {
        end = searchStart + lastBrace + 2;
      }
    }

    chunks.push(code.slice(offset, end));
    offset = end;
  }

  return chunks;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
