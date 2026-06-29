/**
 * MCP Tool: deobfuscate
 *
 * 对JS代码执行反混淆，支持多种预定义变换和自动检测。
 * 使用Babel AST引擎进行代码变换。
 */

import { z } from 'zod';
import { deobfuscate as babelDeobfuscate, applyTransform } from '@core/babel';
import type { Transform } from '@core/babel';
import { MCP_TOOL_TIMEOUT } from '@shared/constants';

// ─── Schema 定义 ───

export const deobfuscateInputSchema = {
  code: z.string().min(1).describe(
    '待反混淆的JS代码字符串。',
  ),
  transforms: z.array(z.string()).optional().describe(
    `指定要应用的变换列表。省略则自动检测并应用所有适用的变换。

可用变换：
- string-array — 还原字符串数组加密（将加密函数调用替换为原始字符串）
- dead-code — 移除永远不会执行的死代码分支
- control-flow — 还原控制流平坦化（while-switch-case模式）
- rename — 基于上下文语义重命名混淆变量（alpha命名）
- constant-fold — 常量折叠（计算编译期可确定的表达式）
- member-expression — 将 obj["prop"] 还原为 obj.prop
- boolean-simplify — 将 ![] 还原为 false，!![] 还原为 true
- hex-numeric — 将十六进制数字字面量还原为十进制
- unicode-escape — 还原Unicode转义字符串
- comma-expression — 展开逗号表达式为独立语句`,
  ),
};

// ─── Tool 元数据 ───

export const deobfuscateMeta = {
  name: 'deobfuscate',
  description: `对混淆的JavaScript代码执行反混淆处理。

功能：
- 自动检测混淆类型并选择合适的变换
- 支持手动指定变换列表（精确控制处理流程）
- 多轮迭代直到代码不再变化
- 返回清洗后的代码、已应用的变换列表和置信度

支持处理的混淆类型：
- Obfuscator.io 生成的混淆代码
- JavaScript-obfuscator 生成的代码
- 自定义字符串加密（string array rotation）
- 控制流平坦化
- 变量名混淆
- 十六进制/Unicode编码
- 死代码注入
- 逗号表达式嵌套

注意：反混淆不等于解密，对于JSVMP保护的代码需配合trace_execution工具。`,
};

// ─── Handler ───

export interface DeobfuscateInput {
  code: string;
  transforms?: string[];
}

export interface DeobfuscateOutput {
  cleanedCode: string;
  transformsApplied: string[];
  confidence: number;
  stats: {
    originalLength: number;
    cleanedLength: number;
    reductionPercent: number;
    iterationsRun: number;
  };
}

/** 所有可用变换名称 */
const AVAILABLE_TRANSFORMS = [
  'string-array',
  'dead-code',
  'control-flow',
  'rename',
  'constant-fold',
  'member-expression',
  'boolean-simplify',
  'hex-numeric',
  'unicode-escape',
  'comma-expression',
] as const;

/**
 * deobfuscate 工具执行函数
 */
export async function handleDeobfuscate(
  args: DeobfuscateInput,
): Promise<DeobfuscateOutput> {
  const originalLength = args.code.length;
  const transformsApplied: string[] = [];
  let currentCode = args.code;
  let confidence = 0;
  let iterations = 0;
  const maxIterations = 5;
  const timeout = MCP_TOOL_TIMEOUT - 5000; // 留5秒余量

  const startTime = Date.now();

  if (args.transforms && args.transforms.length > 0) {
    // 手动指定变换：按顺序逐个应用
    // 将用户友好的变换名称映射到内部Transform名称
    const transformMapping: Record<string, Transform> = {
      'string-array': 'stringArrayDecrypt',
      'dead-code': 'deadCodeElimination',
      'control-flow': 'controlFlowUnflattening',
      'constant-fold': 'constantFolding',
      // 以下变换通过完整deobfuscate流程处理
      'rename': 'constantFolding',
      'member-expression': 'constantFolding',
      'boolean-simplify': 'constantFolding',
      'hex-numeric': 'constantFolding',
      'unicode-escape': 'stringArrayDecrypt',
      'comma-expression': 'deadCodeElimination',
    };

    const validTransforms: Transform[] = [];
    for (const transformName of args.transforms) {
      if (Date.now() - startTime > timeout) break;

      const mapped = transformMapping[transformName];
      if (!mapped) {
        console.warn(`[deobfuscate] Unknown transform: ${transformName}, skipping`);
        continue;
      }
      validTransforms.push(mapped);
      transformsApplied.push(transformName);
    }

    if (validTransforms.length > 0) {
      try {
        const result = applyTransform(currentCode, validTransforms);
        if (result !== currentCode) {
          currentCode = result;
          confidence += 0.1 * validTransforms.length;
        }
        iterations++;
      } catch (err) {
        console.warn(`[deobfuscate] applyTransform failed:`, err);
      }
    }
  } else {
    // 自动模式：使用 babel deobfuscator 自动检测并应用
    let changed = true;
    while (changed && iterations < maxIterations) {
      if (Date.now() - startTime > timeout) break;

      changed = false;
      iterations++;

      try {
        const result = babelDeobfuscate(currentCode);

        if (result.code !== currentCode) {
          currentCode = result.code;
          changed = true;

          // 记录应用的变换
          if (result.transformsApplied) {
            for (const t of result.transformsApplied) {
              if (!transformsApplied.includes(t)) {
                transformsApplied.push(t);
              }
            }
          }
          confidence = Math.max(confidence, result.confidence || 0);
        }
      } catch (err) {
        console.warn(`[deobfuscate] Auto iteration ${iterations} failed:`, err);
        break;
      }
    }
  }

  // 计算缩减比例
  const cleanedLength = currentCode.length;
  const reductionPercent = originalLength > 0
    ? Math.round(((originalLength - cleanedLength) / originalLength) * 100)
    : 0;

  // 归一化 confidence
  confidence = Math.min(1, Math.max(0, confidence));

  // 如果代码有明显缩减，提升置信度
  if (reductionPercent > 20 && confidence < 0.5) {
    confidence = Math.max(confidence, 0.5);
  }
  if (transformsApplied.length > 3 && confidence < 0.7) {
    confidence = Math.max(confidence, 0.7);
  }

  return {
    cleanedCode: currentCode,
    transformsApplied,
    confidence,
    stats: {
      originalLength,
      cleanedLength,
      reductionPercent,
      iterationsRun: iterations,
    },
  };
}
