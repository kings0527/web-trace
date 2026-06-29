/**
 * MCP Tool: analyze_wasm
 *
 * WASM 模块反汇编和分析。
 * 分析函数结构、加密算法特征、控制流。
 */

import { z } from 'zod';
import type { WasmFunctionInfo, CryptoSignature } from '@shared/types';
import { parseModule, decodeFunctionBody, detectCryptoConstants, validateWasmBinary } from '@core/wasm';

// ─── Schema 定义 ───

export const analyzeWasmInputSchema = {
  wasmBinary: z.array(z.number().int().min(0).max(255)).optional().describe(
    'WASM二进制数据（字节数组）。与moduleIndex二选一。',
  ),
  moduleIndex: z.number().int().min(0).optional().describe(
    '使用extract_wasm捕获的模块索引（从页面捕获的WASM模块列表中选取）。',
  ),
  functionName: z.string().optional().describe(
    '只分析指定名称的导出函数。不指定则分析所有函数。',
  ),
  disassemble: z.boolean().optional().default(false).describe(
    '是否输出反汇编文本。对大型模块可能产生大量输出。',
  ),
  maxFunctions: z.number().int().min(1).max(500).optional().default(100).describe(
    '最多分析的函数数量限制。',
  ),
};

// ─── Tool 元数据 ───

export const analyzeWasmMeta = {
  name: 'analyze_wasm',
  description: `反汇编和分析WASM模块结构，识别加密算法特征。

功能：
- 解析WASM二进制section结构
- 提取所有函数信息（参数、返回值、局部变量、调用关系）
- 反汇编函数体为WAT文本格式子集
- 扫描加密算法常量特征：
  · AES S-Box → AES/AES-GCM
  · SHA-256 IV/K → SHA-256
  · ChaCha sigma + ARX模式 → ChaCha20/Poly1305
  · SM3 IV → 国密SM3
  · SM4 FK → 国密SM4
  · MD5 T-table → MD5
- 分析函数调用图（callees）

输入WASM字节数组或使用extract_wasm提取的模块索引。`,
};

// ─── Handler ───

export interface AnalyzeWasmInput {
  wasmBinary?: number[];
  moduleIndex?: number;
  functionName?: string;
  disassemble?: boolean;
  maxFunctions?: number;
}

export interface AnalyzeWasmOutput {
  functions: WasmFunctionInfo[];
  cryptoSignatures: CryptoSignature[];
  controlFlow: string;
  disassembly?: string;
  summary: {
    totalFunctions: number;
    totalExports: number;
    totalImports: number;
    memoryPages: number;
    tableSize: number;
  };
}

/**
 * analyze_wasm 工具执行函数
 */
export async function handleAnalyzeWasm(
  args: AnalyzeWasmInput,
): Promise<AnalyzeWasmOutput> {
  let binary: Uint8Array;

  if (args.wasmBinary && args.wasmBinary.length > 0) {
    binary = new Uint8Array(args.wasmBinary);
  } else if (args.moduleIndex !== undefined) {
    // 从页面获取已捕获的 WASM 模块
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      throw new Error('No active tab found');
    }

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (index: number) => {
        const captured = (window as any).__wt_wasm_captured as Array<{
          source: string;
          bytes: number[];
          size: number;
        }> | undefined;

        if (!captured || index >= captured.length) {
          return null;
        }
        return captured[index].bytes;
      },
      args: [args.moduleIndex],
      world: 'MAIN' as chrome.scripting.ExecutionWorld,
    });

    const bytes = results?.[0]?.result;
    if (!bytes || !Array.isArray(bytes) || bytes.length === 0) {
      throw new Error(`No WASM module found at index ${args.moduleIndex}. Use extract_wasm first.`);
    }
    binary = new Uint8Array(bytes);
  } else {
    throw new Error('Either wasmBinary or moduleIndex must be provided');
  }

  if (!validateWasmBinary(binary)) {
    throw new Error('Invalid WASM binary: bad magic number or version');
  }

  // 解析模块
  const module = parseModule(binary);
  const maxFuncs = args.maxFunctions ?? 100;

  // 过滤函数
  let functions = module.functions;
  if (args.functionName) {
    functions = functions.filter((f) => f.name === args.functionName);
    if (functions.length === 0) {
      // 尝试模糊匹配
      functions = module.functions.filter((f) =>
        f.name.toLowerCase().includes(args.functionName!.toLowerCase()),
      );
    }
  }
  functions = functions.slice(0, maxFuncs);

  // 加密算法检测
  const cryptoSignatures = detectCryptoConstants(module);

  // 生成控制流概述
  const controlFlow = generateControlFlowSummary(module, functions);

  // 反汇编
  let disassembly: string | undefined;
  if (args.disassemble) {
    disassembly = generateDisassembly(binary, module, functions);
  }

  return {
    functions,
    cryptoSignatures,
    controlFlow,
    disassembly,
    summary: {
      totalFunctions: module.functions.length,
      totalExports: module.exports.length,
      totalImports: module.imports.length,
      memoryPages: module.memoryPages,
      tableSize: module.tableSize,
    },
  };
}

/**
 * 生成控制流概要
 */
function generateControlFlowSummary(
  module: ReturnType<typeof parseModule>,
  functions: WasmFunctionInfo[],
): string {
  const lines: string[] = [];
  lines.push(`Module: ${module.functions.length} functions, ${module.exports.length} exports`);
  lines.push(`Memory: ${module.memoryPages} pages (${module.memoryPages * 64}KB)`);
  lines.push('');
  lines.push('Call Graph (top functions):');

  for (const func of functions.slice(0, 20)) {
    const calleeNames = func.callees.map((idx) => {
      const target = module.functions.find((f) => f.index === idx);
      return target ? target.name : `func_${idx}`;
    });
    const calleesStr = calleeNames.length > 0 ? ` → [${calleeNames.join(', ')}]` : '';
    lines.push(`  ${func.name}(${func.params.join(', ')}) → ${func.results.join(', ') || 'void'}${calleesStr}`);
  }

  if (functions.length > 20) {
    lines.push(`  ... and ${functions.length - 20} more functions`);
  }

  return lines.join('\n');
}

/**
 * 生成反汇编文本
 */
function generateDisassembly(
  binary: Uint8Array,
  module: ReturnType<typeof parseModule>,
  functions: WasmFunctionInfo[],
): string {
  const lines: string[] = [];
  const codeSection = module.sections.find((s) => s.id === 10);

  if (!codeSection) {
    return '(no code section found)';
  }

  // 反汇编每个函数（限制总行数）
  const maxTotalLines = 2000;
  let totalLines = 0;

  // 重新解析 code section 获取函数体
  const reader = codeSection.data;
  let offset = 0;
  // 读取 function count (LEB128)
  let funcCount = 0;
  let byte: number;
  let shift = 0;
  do {
    byte = reader[offset++];
    funcCount |= (byte & 0x7f) << shift;
    shift += 7;
  } while (byte & 0x80);

  const importFuncCount = module.imports.filter((i) => i.kind === 'function').length;

  for (let i = 0; i < funcCount && totalLines < maxTotalLines; i++) {
    // 读取 body size
    let bodySize = 0;
    shift = 0;
    do {
      byte = reader[offset++];
      bodySize |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);

    const funcIndex = importFuncCount + i;
    const func = functions.find((f) => f.index === funcIndex);

    if (func) {
      const bodyBytes = reader.slice(offset, offset + bodySize);
      const instructions = decodeFunctionBody(bodyBytes, 200);

      lines.push(`(func $${func.name} (;${func.index};) (param ${func.params.join(' ')}) (result ${func.results.join(' ')})`);
      for (const instr of instructions) {
        const operandsStr = instr.operands.length > 0 ? ' ' + instr.operands.join(' ') : '';
        lines.push(`  ${instr.mnemonic}${operandsStr}`);
        totalLines++;
        if (totalLines >= maxTotalLines) {
          lines.push('  ;; ... truncated');
          break;
        }
      }
      lines.push(')');
      lines.push('');
      totalLines += 3;
    }

    offset += bodySize;
  }

  return lines.join('\n');
}
