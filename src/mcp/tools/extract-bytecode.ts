/**
 * MCP Tool: extract_bytecode
 *
 * 从页面中提取JSVMP字节码数组。
 * 支持通过URL下载脚本、通过CSS选择器定位script标签、或直接读取已知全局变量。
 */

import { z } from 'zod';
import { MCP_TOOL_TIMEOUT } from '@shared/constants';

// ─── Schema 定义 ───

export const extractBytecodeInputSchema = {
  scriptUrl: z.string().url().optional().describe(
    '包含字节码的JS文件URL。工具会下载并分析该文件提取字节码数组。',
  ),
  selector: z.string().optional().describe(
    'CSS选择器，用于定位页面中包含字节码的<script>标签。例如: "script[data-vm]"',
  ),
  variableName: z.string().optional().describe(
    '页面中已知的字节码变量名。工具将直接从页面执行环境中读取该变量的值。',
  ),
};

// ─── Tool 元数据 ───

export const extractBytecodeMeta = {
  name: 'extract_bytecode',
  description: `从页面中提取JSVMP字节码数组。

支持三种提取方式（至少指定一个）：
1. scriptUrl — 下载指定URL的JS文件，自动识别并提取其中的大型数值数组
2. selector — 通过CSS选择器定位页面中的<script>标签并分析其内容
3. variableName — 直接在页面MAIN世界中读取已知的全局变量值

字节码识别策略：
- 查找长度>100的纯数值数组（var bytecode = [1,2,3,...]）
- 识别常见模式：连续整数赋值、Uint8Array/Int32Array初始化
- 支持十六进制编码的字节码

返回提取到的字节码数组、格式信息和来源信息。`,
};

// ─── Handler ───

export interface ExtractBytecodeInput {
  scriptUrl?: string;
  selector?: string;
  variableName?: string;
}

export interface ExtractBytecodeOutput {
  bytecode: number[];
  format: 'int-array' | 'uint8' | 'int32' | 'hex-string' | 'unknown';
  sourceInfo: {
    method: 'url' | 'selector' | 'variable';
    source: string;
    totalArraysFound: number;
    selectedArrayLength: number;
  };
}

/** 从JS源码中提取数值数组 */
function extractArraysFromSource(source: string): Array<{ name: string; values: number[] }> {
  const arrays: Array<{ name: string; values: number[] }> = [];

  // 模式1: var/let/const name = [1, 2, 3, ...]
  const arrayLiteralRegex =
    /(?:var|let|const)\s+([\w$]+)\s*=\s*\[([\d,\s\-]+)\]/g;
  let match: RegExpExecArray | null;

  while ((match = arrayLiteralRegex.exec(source)) !== null) {
    const name = match[1];
    const values = match[2]
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !isNaN(n));

    if (values.length >= 50) {
      arrays.push({ name, values });
    }
  }

  // 模式2: new Uint8Array([1, 2, 3, ...])
  const typedArrayRegex =
    /(?:var|let|const)\s+([\w$]+)\s*=\s*new\s+(?:Uint8Array|Int32Array|Uint32Array|Int16Array)\s*\(\s*\[([\d,\s\-]+)\]\s*\)/g;

  while ((match = typedArrayRegex.exec(source)) !== null) {
    const name = match[1];
    const values = match[2]
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !isNaN(n));

    if (values.length >= 50) {
      arrays.push({ name, values });
    }
  }

  // 模式3: 十六进制字符串 "0a1b2c3d..."
  const hexStringRegex =
    /(?:var|let|const)\s+([\w$]+)\s*=\s*["']([0-9a-fA-F]{100,})["']/g;

  while ((match = hexStringRegex.exec(source)) !== null) {
    const name = match[1];
    const hexStr = match[2];
    const values: number[] = [];
    for (let i = 0; i < hexStr.length; i += 2) {
      values.push(parseInt(hexStr.slice(i, i + 2), 16));
    }
    if (values.length >= 50) {
      arrays.push({ name, values });
    }
  }

  // 按长度排序，最大的最可能是字节码
  arrays.sort((a, b) => b.values.length - a.values.length);

  return arrays;
}

/** 检测字节码格式 */
function detectFormat(values: number[]): ExtractBytecodeOutput['format'] {
  if (values.length === 0) return 'unknown';

  const max = Math.max(...values.slice(0, 1000));
  const min = Math.min(...values.slice(0, 1000));

  if (min >= 0 && max <= 255) return 'uint8';
  if (min >= -2147483648 && max <= 2147483647) return 'int32';
  if (min >= 0) return 'int-array';
  return 'unknown';
}

/**
 * extract_bytecode 工具执行函数
 */
export async function handleExtractBytecode(
  args: ExtractBytecodeInput,
): Promise<ExtractBytecodeOutput> {
  if (!args.scriptUrl && !args.selector && !args.variableName) {
    throw new Error('At least one of scriptUrl, selector, or variableName must be provided');
  }

  // 方式1: 通过URL下载并分析
  if (args.scriptUrl) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), MCP_TOOL_TIMEOUT - 5000);

    let source: string;
    try {
      const response = await fetch(args.scriptUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
      });
      source = await response.text();
    } finally {
      clearTimeout(timeoutId);
    }

    const arrays = extractArraysFromSource(source);
    if (arrays.length === 0) {
      throw new Error(`No bytecode arrays found in script: ${args.scriptUrl}`);
    }

    const best = arrays[0];
    return {
      bytecode: best.values,
      format: detectFormat(best.values),
      sourceInfo: {
        method: 'url',
        source: args.scriptUrl,
        totalArraysFound: arrays.length,
        selectedArrayLength: best.values.length,
      },
    };
  }

  // 方式2: 通过选择器定位页面中的script
  if (args.selector) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('No active tab found');

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (sel: string) => {
        const el = document.querySelector(sel);
        return el?.textContent || '';
      },
      args: [args.selector],
      world: 'MAIN' as chrome.scripting.ExecutionWorld,
    });

    const scriptContent = results?.[0]?.result || '';
    if (!scriptContent) {
      throw new Error(`No script content found for selector: ${args.selector}`);
    }

    const arrays = extractArraysFromSource(scriptContent);
    if (arrays.length === 0) {
      throw new Error(`No bytecode arrays found in selected script element`);
    }

    const best = arrays[0];
    return {
      bytecode: best.values,
      format: detectFormat(best.values),
      sourceInfo: {
        method: 'selector',
        source: args.selector,
        totalArraysFound: arrays.length,
        selectedArrayLength: best.values.length,
      },
    };
  }

  // 方式3: 直接读取页面全局变量
  if (args.variableName) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('No active tab found');

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (varName: string) => {
        try {
          // 支持嵌套属性访问 (e.g., "window.vm.bytecode")
          const parts = varName.split('.');
          let obj: unknown = globalThis;
          for (const part of parts) {
            if (obj === null || obj === undefined) return null;
            obj = (obj as Record<string, unknown>)[part];
          }
          if (Array.isArray(obj)) return obj;
          if (obj instanceof Uint8Array || obj instanceof Int32Array) {
            return Array.from(obj);
          }
          return null;
        } catch {
          return null;
        }
      },
      args: [args.variableName],
      world: 'MAIN' as chrome.scripting.ExecutionWorld,
    });

    const rawValue = results?.[0]?.result;
    if (!rawValue || !Array.isArray(rawValue)) {
      throw new Error(`Variable "${args.variableName}" not found or not an array`);
    }

    const values = rawValue.map(Number).filter((n) => !isNaN(n));
    return {
      bytecode: values,
      format: detectFormat(values),
      sourceInfo: {
        method: 'variable',
        source: args.variableName,
        totalArraysFound: 1,
        selectedArrayLength: values.length,
      },
    };
  }

  // 不应到达
  throw new Error('No extraction method specified');
}
