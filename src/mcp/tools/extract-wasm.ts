/**
 * MCP Tool: extract_wasm
 *
 * 识别和提取页面中的 WASM 模块。
 * 通过 Hook WebAssembly.instantiate/instantiateStreaming 或
 * 从指定 scriptUrl 下载解析 WASM binary。
 */

import { z } from 'zod';
import type { WasmModuleInfo } from '@shared/types';
import { MCP_TOOL_TIMEOUT } from '@shared/constants';
import { validateWasmBinary, extractModuleMetadata } from '@core/wasm';

// ─── Schema 定义 ───

export const extractWasmInputSchema = {
  scriptUrl: z.string().url().optional().describe(
    '指定的WASM文件URL。如果提供则直接下载该URL的WASM二进制并解析。',
  ),
  pageContext: z.boolean().optional().default(true).describe(
    '是否从当前页面上下文中提取WASM模块。通过Hook WebAssembly API捕获已加载的模块。',
  ),
};

// ─── Tool 元数据 ───

export const extractWasmMeta = {
  name: 'extract_wasm',
  description: `从页面或指定URL中提取WASM模块并解析其结构信息。

功能：
- 通过Hook WebAssembly.instantiate/instantiateStreaming捕获页面加载的WASM模块
- 支持直接下载指定URL的.wasm文件进行解析
- 解析WASM二进制section结构
- 提取导出函数列表、导入依赖、内存配置等元数据
- 识别WASM magic number (\\0asm) 验证有效性

返回每个检测到的WASM模块的完整元数据信息。`,
};

// ─── Handler ───

export interface ExtractWasmInput {
  scriptUrl?: string;
  pageContext?: boolean;
}

export interface ExtractWasmOutput {
  modules: WasmModuleInfo[];
}

/**
 * extract_wasm 工具执行函数
 */
export async function handleExtractWasm(
  args: ExtractWasmInput,
): Promise<ExtractWasmOutput> {
  const modules: WasmModuleInfo[] = [];

  // 1. 如果指定了 URL，直接下载并解析
  if (args.scriptUrl) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), MCP_TOOL_TIMEOUT - 5000);

    try {
      const response = await fetch(args.scriptUrl, {
        signal: controller.signal,
        headers: {
          'Accept': 'application/wasm, application/octet-stream, */*',
        },
      });

      const arrayBuffer = await response.arrayBuffer();
      const binary = new Uint8Array(arrayBuffer);

      if (validateWasmBinary(binary)) {
        const metadata = extractModuleMetadata(binary);
        modules.push({
          source: args.scriptUrl,
          size: binary.byteLength,
          exports: metadata.exports,
          imports: metadata.imports,
          memoryPages: metadata.memoryPages,
          tableSize: metadata.tableSize,
          customSections: metadata.customSections,
        });
      } else {
        // 可能是JS文件中嵌入了WASM（如知乎 emo.js）
        // 尝试从 JS 内容中提取嵌入的 WASM binary
        const jsContent = new TextDecoder('utf-8', { fatal: false }).decode(binary);
        const extractedWasm = extractEmbeddedWasm(jsContent);
        if (extractedWasm.length > 0) {
          for (const wasmBinary of extractedWasm) {
            if (validateWasmBinary(wasmBinary)) {
              try {
                const metadata = extractModuleMetadata(wasmBinary);
                modules.push({
                  source: `${args.scriptUrl} [embedded]`,
                  size: wasmBinary.byteLength,
                  exports: metadata.exports,
                  imports: metadata.imports,
                  memoryPages: metadata.memoryPages,
                  tableSize: metadata.tableSize,
                  customSections: metadata.customSections,
                });
              } catch {
                modules.push({
                  source: `${args.scriptUrl} [embedded]`,
                  size: wasmBinary.byteLength,
                  exports: [],
                  imports: [],
                  memoryPages: 0,
                  tableSize: 0,
                  customSections: [],
                });
              }
            }
          }
          if (extractedWasm.length === 0 || modules.length === 0) {
            throw new Error(`URL ${args.scriptUrl} does not contain valid WASM binary (bad magic number) and no embedded WASM found in JS content`);
          }
        } else {
          throw new Error(`URL ${args.scriptUrl} does not contain valid WASM binary (bad magic number) and no embedded WASM found in JS content`);
        }
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // 2. 从页面上下文中提取
  if (args.pageContext !== false) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      if (modules.length === 0) {
        throw new Error('No active tab found and no scriptUrl provided');
      }
      return { modules };
    }

    // 注入代码到页面中，读取已 Hook 捕获的 WASM 模块信息
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        // 检查之前是否已经 Hook 过 WebAssembly API
        const captured = (window as any).__wt_wasm_captured as Array<{
          source: string;
          bytes: number[];
          size: number;
        }> | undefined;

        if (captured && captured.length > 0) {
          return captured.map((item) => ({
            source: item.source,
            bytes: item.bytes,
            size: item.size,
          }));
        }

        // 如果没有已捕获的模块，设置 Hook 并返回空
        // Hook WebAssembly.instantiate
        const origInstantiate = WebAssembly.instantiate;
        const origInstantiateStreaming = WebAssembly.instantiateStreaming;
        const capturedModules: Array<{ source: string; bytes: number[]; size: number }> = [];
        (window as any).__wt_wasm_captured = capturedModules;

        WebAssembly.instantiate = function (
          bufferSource: BufferSource | WebAssembly.Module,
          importObject?: WebAssembly.Imports,
        ): Promise<WebAssembly.WebAssemblyInstantiatedSource | WebAssembly.Instance> {
          if (bufferSource instanceof ArrayBuffer || ArrayBuffer.isView(bufferSource)) {
            const bytes = bufferSource instanceof ArrayBuffer
              ? new Uint8Array(bufferSource)
              : new Uint8Array((bufferSource as any).buffer, (bufferSource as any).byteOffset, (bufferSource as any).byteLength);
            // 只保留前 64KB 用于解析元数据
            const capSize = Math.min(bytes.length, 65536);
            capturedModules.push({
              source: 'WebAssembly.instantiate(bytes)',
              bytes: Array.from(bytes.slice(0, capSize)),
              size: bytes.length,
            });
          }
          return origInstantiate.call(WebAssembly, bufferSource as any, importObject) as any;
        } as any;

        if (origInstantiateStreaming) {
          WebAssembly.instantiateStreaming = function (
            source: Response | PromiseLike<Response>,
            importObject?: WebAssembly.Imports,
          ): Promise<WebAssembly.WebAssemblyInstantiatedSource> {
            const streamingPromise = origInstantiateStreaming.call(WebAssembly, source, importObject);
            // 尝试从 response 获取 URL
            if (source instanceof Response) {
              capturedModules.push({
                source: source.url || 'WebAssembly.instantiateStreaming',
                bytes: [],
                size: 0,
              });
            }
            return streamingPromise;
          } as any;
        }

        return null; // Hook 已设置，但本次没有已捕获的数据
      },
      world: 'MAIN' as chrome.scripting.ExecutionWorld,
    });

    const pageModules = results?.[0]?.result;

    if (Array.isArray(pageModules)) {
      for (const item of pageModules) {
        if (item.bytes && item.bytes.length > 0) {
          const binary = new Uint8Array(item.bytes);
          if (validateWasmBinary(binary)) {
            try {
              const metadata = extractModuleMetadata(binary);
              modules.push({
                source: item.source,
                size: item.size,
                exports: metadata.exports,
                imports: metadata.imports,
                memoryPages: metadata.memoryPages,
                tableSize: metadata.tableSize,
                customSections: metadata.customSections,
              });
            } catch {
              // 解析失败，添加基本信息
              modules.push({
                source: item.source,
                size: item.size,
                exports: [],
                imports: [],
                memoryPages: 0,
                tableSize: 0,
                customSections: [],
              });
            }
          }
        } else {
          // Streaming 加载的模块，只有 URL 信息
          modules.push({
            source: item.source,
            size: item.size || 0,
            exports: [],
            imports: [],
            memoryPages: 0,
            tableSize: 0,
            customSections: [],
          });
        }
      }
    }
  }

  return { modules };
}

/**
 * 从 JS 代码中提取嵌入的 WASM binary。
 * 支持以下模式：
 * 1. new Uint8Array([0,97,115,109,...])  — WASM magic number 字节数组
 * 2. Base64 编码的 WASM (AGFzbQ...)
 * 3. 十六进制字符串 "\x00asm" 或 "0061736d"
 */
function extractEmbeddedWasm(jsContent: string): Uint8Array[] {
  const results: Uint8Array[] = [];

  // 模式 1: new Uint8Array([0,97,115,109, ...]) — WASM magic number
  const uint8Pattern = /new\s+Uint8Array\s*\(\s*\[\s*(0\s*,\s*97\s*,\s*115\s*,\s*109[\s\S]*?)\]\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = uint8Pattern.exec(jsContent)) !== null) {
    try {
      const numStr = match[1];
      // 提取数字，限制解析长度避免内存爆炸
      const numbers = numStr.split(',').slice(0, 65536).map((s) => parseInt(s.trim(), 10));
      if (numbers.length >= 8 && numbers[0] === 0 && numbers[1] === 97 && numbers[2] === 115 && numbers[3] === 109) {
        results.push(new Uint8Array(numbers));
      }
    } catch { /* 解析失败，跳过 */ }
  }

  // 模式 2: Base64 编码的 WASM（以 AGFzbQ 开头，即 \x00asm 的 base64）
  const base64Pattern = /["']([A-Za-z0-9+/]*AGFzbQ[A-Za-z0-9+/=]{20,})["']/g;
  while ((match = base64Pattern.exec(jsContent)) !== null) {
    try {
      const b64 = match[1];
      // 找到 AGFzbQ 的位置，从这里开始解码
      const idx = b64.indexOf('AGFzbQ');
      const wasmB64 = b64.slice(idx);
      const binaryStr = atob(wasmB64);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }
      if (bytes.length >= 8 && bytes[0] === 0 && bytes[1] === 0x61 && bytes[2] === 0x73 && bytes[3] === 0x6d) {
        results.push(bytes);
      }
    } catch { /* base64解码失败，跳过 */ }
  }

  // 模式 3: 十六进制字符串 "0061736d" 或大型数字数组 [0x00,0x61,0x73,0x6d,...]
  const hexArrayPattern = /\[\s*(0x00\s*,\s*0x61\s*,\s*0x73\s*,\s*0x6d[\s\S]*?)\]/g;
  while ((match = hexArrayPattern.exec(jsContent)) !== null) {
    try {
      const hexStr = match[1];
      const numbers = hexStr.split(',').slice(0, 65536).map((s) => parseInt(s.trim(), 16));
      if (numbers.length >= 8 && numbers[0] === 0 && numbers[1] === 0x61 && numbers[2] === 0x73 && numbers[3] === 0x6d) {
        results.push(new Uint8Array(numbers));
      }
    } catch { /* 解析失败，跳过 */ }
  }

  return results;
}
