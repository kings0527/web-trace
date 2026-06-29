/**
 * MCP Tool: detect_protection
 *
 * 检测当前页面或指定URL的反爬保护类型和等级。
 * 分析JS混淆程度、JSVMP特征、WASM模块、请求签名参数等。
 */

import { z } from 'zod';
import type { ProtectionInfo } from '@shared/types';
import { MCP_TOOL_TIMEOUT } from '@shared/constants';

// ─── Schema 定义 ───

export const detectProtectionInputSchema = {
  url: z.string().url().optional().describe(
    '待检测的页面URL。省略则分析当前活跃tab的页面。',
  ),
};

// ─── Tool 元数据 ───

export const detectProtectionMeta = {
  name: 'detect_protection',
  description: `检测指定URL或当前页面的反爬/反调试保护类型和等级。

功能：
- 识别Cloudflare、瑞数(RuiShu)、同盾等Challenge页面特征
- 分析JS代码混淆程度（变量名模式、字符串加密、控制流平坦化）
- 检测JSVMP虚拟机保护（while-switch大型派发循环）
- 检测WASM加密模块
- 识别请求签名参数模式

返回保护类型(type)、等级(level 1-5)、特征列表(features)和置信度(confidence)。`,
};

// ─── 检测逻辑 ───

/** 分析页面源码中的保护特征 */
function analyzeProtectionFeatures(source: string): ProtectionInfo {
  const features: string[] = [];
  let level: 1 | 2 | 3 | 4 | 5 = 1;
  let type: ProtectionInfo['type'] = 'none';
  let confidenceScore = 0;

  // 1. 检测 Challenge 页面特征
  const challengePatterns = [
    { pattern: /cf[-_]?chl[-_]?bypass/i, name: 'Cloudflare Challenge' },
    { pattern: /__cf_chl_rt_tk/i, name: 'Cloudflare Turnstile' },
    { pattern: /cdn-cgi\/challenge-platform/i, name: 'Cloudflare Challenge Platform' },
    { pattern: /\$_ts\s*=\s*\{/i, name: 'RuiShu Cookie Mode' },
    { pattern: /\$_zw\s*\[/i, name: 'RuiShu Var Pattern' },
    { pattern: /content="never".*name="referrer"/i, name: 'Anti-Referrer' },
  ];

  for (const { pattern, name } of challengePatterns) {
    if (pattern.test(source)) {
      features.push(name);
      confidenceScore += 15;
    }
  }

  // 2. 检测 JS 混淆程度
  const obfuscationIndicators = [
    // 短变量名密集使用
    { pattern: /var\s+[_$a-z]{1,2}\s*[=,;]/g, threshold: 50, name: 'Short var names' },
    // 十六进制字符串
    { pattern: /\\x[0-9a-f]{2}/gi, threshold: 20, name: 'Hex string encoding' },
    // Unicode 转义
    { pattern: /\\u[0-9a-f]{4}/gi, threshold: 30, name: 'Unicode escaping' },
    // 字符串数组解密函数
    { pattern: /function\s*\w*\s*\(\s*\w+\s*,\s*\w+\s*\)\s*\{[^}]*parseInt/g, threshold: 3, name: 'String array decryptor' },
    // 控制流平坦化
    { pattern: /switch\s*\(\s*\w+\[?\w*\]?\s*\)\s*\{(\s*case\s+)/g, threshold: 5, name: 'Control flow flattening' },
  ];

  for (const { pattern, threshold, name } of obfuscationIndicators) {
    const matches = source.match(pattern);
    if (matches && matches.length >= threshold) {
      features.push(name);
      confidenceScore += 10;
    }
  }

  // 3. 检测 JSVMP 特征（大型 while-switch 派发循环）
  const jsvmpPatterns = [
    // while(true) { switch(opcode) { case N: ... }}
    { pattern: /while\s*\(\s*!?[01!]?\s*\)\s*\{?\s*switch\s*\(/g, threshold: 1, name: 'JSVMP dispatch loop' },
    // 字节码数组特征
    { pattern: /\[\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*\d+/g, threshold: 3, name: 'Bytecode array' },
    // PC 计数器递增
    { pattern: /\w+\s*\+\+\s*[;,\]]/g, threshold: 20, name: 'PC increment pattern' },
    // handler table
    { pattern: /\[\s*function\s*\(\s*\)\s*\{/g, threshold: 10, name: 'Handler table' },
  ];

  let hasJsvmp = false;
  for (const { pattern, threshold, name } of jsvmpPatterns) {
    const matches = source.match(pattern);
    if (matches && matches.length >= threshold) {
      features.push(name);
      confidenceScore += 20;
      hasJsvmp = true;
    }
  }

  // 4. 检测 WASM 模块
  const wasmPatterns = [
    { pattern: /WebAssembly\.(instantiate|compile|Module)/g, name: 'WebAssembly usage' },
    { pattern: /\.wasm/gi, name: 'WASM file reference' },
    { pattern: /new\s+Uint8Array\s*\(\s*\[.*?\]\s*\)/g, name: 'Inline WASM bytes' },
  ];

  let hasWasm = false;
  for (const { pattern, name } of wasmPatterns) {
    if (pattern.test(source)) {
      features.push(name);
      confidenceScore += 15;
      hasWasm = true;
    }
  }

  // 5. 检测请求签名参数
  const sigPatterns = [
    { pattern: /[?&](_signature|sign|token|_s|X-Bogus|msToken)/gi, name: 'URL signature params' },
    { pattern: /x-tt-params|x-ss-stub|x-gorgon|x-argus|x-ladon|x-khronos/gi, name: 'TikTok-style headers' },
    { pattern: /a]?_bogus|X[-_]Bogus/gi, name: 'Bogus parameter' },
  ];

  for (const { pattern, name } of sigPatterns) {
    if (pattern.test(source)) {
      features.push(name);
      confidenceScore += 10;
    }
  }

  // ─── 综合判定 ───
  if (hasJsvmp && hasWasm) {
    type = 'combined';
    level = 5;
  } else if (hasJsvmp) {
    type = 'jsvmp';
    level = 4;
  } else if (hasWasm) {
    type = 'wasm';
    level = 4;
  } else if (features.length > 3) {
    type = 'obfuscation';
    level = 3;
  } else if (features.length > 0) {
    type = 'obfuscation';
    level = 2;
  }

  // 归一化 confidence 到 0-1 范围
  const confidence = Math.min(1, confidenceScore / 100);

  return { type, level, features, confidence };
}

// ─── Handler ───

export interface DetectProtectionInput {
  url?: string;
}

export interface DetectProtectionOutput extends ProtectionInfo {}

/**
 * detect_protection 工具执行函数
 */
export async function handleDetectProtection(
  args: DetectProtectionInput,
): Promise<DetectProtectionOutput> {
  let source = '';

  if (args.url) {
    // 通过 fetch 获取目标页面源码
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), MCP_TOOL_TIMEOUT - 5000);

    try {
      const response = await fetch(args.url, {
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
  } else {
    // 获取当前活跃 tab 的页面源码
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      throw new Error('No active tab found');
    }

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => document.documentElement.outerHTML,
      world: 'MAIN' as chrome.scripting.ExecutionWorld,
    });

    source = results?.[0]?.result || '';

    // 同时收集页面中所有外部脚本的内容
    const scriptResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const scripts = document.querySelectorAll('script:not([src])');
        return Array.from(scripts)
          .map((s) => s.textContent || '')
          .join('\n');
      },
      world: 'MAIN' as chrome.scripting.ExecutionWorld,
    });

    source += '\n' + (scriptResults?.[0]?.result || '');
  }

  if (!source) {
    return {
      type: 'none',
      level: 1,
      features: [],
      confidence: 0,
    };
  }

  return analyzeProtectionFeatures(source);
}
