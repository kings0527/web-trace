/**
 * MCP Tool: dump_wasm_memory
 *
 * 读取 WASM 实例的线性内存指定区域。
 * 通过页面中的 Hook 获取 WebAssembly.Instance 的 memory 对象。
 */

import { z } from 'zod';

// ─── Schema 定义 ───

export const dumpWasmMemoryInputSchema = {
  offset: z.number().int().min(0).describe(
    '读取的起始偏移（字节）。',
  ),
  length: z.number().int().min(1).max(1048576).describe(
    '读取的字节长度。最大1MB (1048576 bytes)。',
  ),
  encoding: z.enum(['hex', 'utf8', 'base64', 'uint8']).optional().default('hex').describe(
    `输出编码格式：
- hex: 十六进制字符串（默认）
- utf8: UTF-8 文本
- base64: Base64 编码
- uint8: JSON数组形式的原始字节`,
  ),
  instanceId: z.string().optional().describe(
    '目标WASM实例ID。如果页面有多个WASM实例，通过此参数指定。默认使用第一个实例。',
  ),
};

// ─── Tool 元数据 ───

export const dumpWasmMemoryMeta = {
  name: 'dump_wasm_memory',
  description: `读取WASM实例的线性内存指定区域。

功能：
- 通过Hook获取的WebAssembly.Instance读取memory.buffer
- 支持指定偏移和长度
- 支持多种输出编码格式（hex/utf8/base64/uint8）
- 自动检测内存边界避免越界
- 支持多实例场景

使用场景：
- 读取WASM加密函数的输入/输出缓冲区
- 分析WASM内存中的密钥材料
- 监控WASM堆上的数据变化
- 提取WASM计算的中间结果

注意：需要先通过hook_api或extract_wasm设置WebAssembly Hook。`,
};

// ─── Handler ───

export interface DumpWasmMemoryInput {
  offset: number;
  length: number;
  encoding?: 'hex' | 'utf8' | 'base64' | 'uint8';
  instanceId?: string;
}

export interface DumpWasmMemoryOutput {
  data: string;
  offset: number;
  length: number;
  totalMemorySize: number;
  encoding: string;
}

/**
 * dump_wasm_memory 工具执行函数
 */
export async function handleDumpWasmMemory(
  args: DumpWasmMemoryInput,
): Promise<DumpWasmMemoryOutput> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error('No active tab found');
  }

  const encoding = args.encoding ?? 'hex';

  // 在页面中执行内存读取
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (
      readOffset: number,
      readLength: number,
      enc: string,
      instId: string | undefined,
    ) => {
      // 查找 WASM memory 实例
      const instances = (window as any).__wt_wasm_instances as Array<{
        id: string;
        instance: WebAssembly.Instance;
        memory: WebAssembly.Memory;
      }> | undefined;

      let memory: WebAssembly.Memory | null = null;

      if (instances && instances.length > 0) {
        if (instId) {
          const target = instances.find((i) => i.id === instId);
          if (target) memory = target.memory;
        } else {
          memory = instances[0].memory;
        }
      }

      // 尝试从已 Hook 的 exports 中查找 memory
      if (!memory) {
        const captured = (window as any).__wt_wasm_captured as Array<{
          source: string;
          memory?: WebAssembly.Memory;
        }> | undefined;
        if (captured) {
          for (const item of captured) {
            if (item.memory) {
              memory = item.memory;
              break;
            }
          }
        }
      }

      if (!memory) {
        return { error: 'No WASM memory instance found. Use hook_api with WebAssembly.instantiate or extract_wasm first.' };
      }

      const buffer = memory.buffer;
      const totalSize = buffer.byteLength;

      // 边界检查
      if (readOffset >= totalSize) {
        return { error: `Offset ${readOffset} exceeds memory size ${totalSize}` };
      }

      const actualLength = Math.min(readLength, totalSize - readOffset);
      const view = new Uint8Array(buffer, readOffset, actualLength);

      let data: string;
      switch (enc) {
        case 'hex': {
          const hexChars: string[] = [];
          for (let i = 0; i < view.length; i++) {
            hexChars.push(view[i].toString(16).padStart(2, '0'));
          }
          data = hexChars.join('');
          break;
        }
        case 'utf8': {
          data = new TextDecoder('utf-8', { fatal: false }).decode(view);
          break;
        }
        case 'base64': {
          let binary = '';
          for (let i = 0; i < view.length; i++) {
            binary += String.fromCharCode(view[i]);
          }
          data = btoa(binary);
          break;
        }
        case 'uint8': {
          data = JSON.stringify(Array.from(view));
          break;
        }
        default:
          data = '';
      }

      return {
        data,
        offset: readOffset,
        length: actualLength,
        totalMemorySize: totalSize,
      };
    },
    args: [args.offset, args.length, encoding, args.instanceId],
    world: 'MAIN' as chrome.scripting.ExecutionWorld,
  });

  const result = results?.[0]?.result as any;

  if (!result) {
    throw new Error('Failed to execute memory dump in page context');
  }

  if (result.error) {
    throw new Error(result.error);
  }

  return {
    data: result.data,
    offset: result.offset,
    length: result.length,
    totalMemorySize: result.totalMemorySize,
    encoding,
  };
}
