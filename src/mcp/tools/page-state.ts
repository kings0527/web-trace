/**
 * MCP Tool: page_state
 *
 * 获取当前页面的完整状态信息。
 * 包括URL、Cookie、Storage、脚本列表、最近网络请求等。
 */

import { z } from 'zod';

// ─── Schema 定义 ───

export const pageStateInputSchema = {};

// ─── Tool 元数据 ───

export const pageStateMeta = {
  name: 'page_state',
  description: `获取当前活跃标签页的完整状态信息。

无需参数，自动获取当前活跃tab的以下信息：
- url: 当前页面URL
- title: 页面标题
- cookies: 该域名下的所有Cookie（名称、值、域、过期时间等）
- localStorage: localStorage中的所有键值对
- sessionStorage: sessionStorage中的所有键值对
- scripts: 页面中所有<script>标签的信息（src、是否内联、内容长度）
- networkRequests: 最近的网络请求记录（如果有Performance API数据）
- meta: 页面meta标签信息

适用于快速了解页面全貌，判断反爬保护策略。`,
};

// ─── Handler ───

export interface PageStateOutput {
  url: string;
  title: string;
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    secure: boolean;
    httpOnly: boolean;
    expirationDate?: number;
  }>;
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
  scripts: Array<{
    src: string | null;
    type: string | null;
    isInline: boolean;
    contentLength: number;
    hasVMPattern: boolean;
  }>;
  networkRequests: Array<{
    name: string;
    initiatorType: string;
    duration: number;
    transferSize: number;
  }>;
  meta: Record<string, string>;
}

/**
 * page_state 工具执行函数
 */
export async function handlePageState(): Promise<PageStateOutput> {
  // 获取当前活跃tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) {
    throw new Error('No active tab found or tab has no URL');
  }

  const tabId = tab.id;
  const url = tab.url;
  const title = tab.title || '';

  // 并行获取：cookies + 页面内数据
  const [cookies, pageData] = await Promise.all([
    // 获取 cookies
    getCookiesForTab(url),
    // 在页面中执行脚本获取各项数据
    getPageInternalData(tabId),
  ]);

  return {
    url,
    title,
    cookies,
    localStorage: pageData.localStorage,
    sessionStorage: pageData.sessionStorage,
    scripts: pageData.scripts,
    networkRequests: pageData.networkRequests,
    meta: pageData.meta,
  };
}

/** 获取指定URL对应域名的所有cookie */
async function getCookiesForTab(url: string): Promise<PageStateOutput['cookies']> {
  try {
    const cookies = await chrome.cookies.getAll({ url });
    return cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      expirationDate: c.expirationDate,
    }));
  } catch {
    return [];
  }
}

/** 在页面中执行脚本获取内部数据 */
async function getPageInternalData(tabId: number): Promise<{
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
  scripts: PageStateOutput['scripts'];
  networkRequests: PageStateOutput['networkRequests'];
  meta: Record<string, string>;
}> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      // 获取 localStorage
      const ls: Record<string, string> = {};
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key) ls[key] = localStorage.getItem(key) || '';
        }
      } catch { /* 可能被禁止访问 */ }

      // 获取 sessionStorage
      const ss: Record<string, string> = {};
      try {
        for (let i = 0; i < sessionStorage.length; i++) {
          const key = sessionStorage.key(i);
          if (key) ss[key] = sessionStorage.getItem(key) || '';
        }
      } catch { /* 可能被禁止访问 */ }

      // 获取 scripts 信息
      const scriptElements = document.querySelectorAll('script');
      const scripts = Array.from(scriptElements).map((s) => {
        const content = s.textContent || '';
        const hasVMPattern =
          /while\s*\(\s*!?[01!]?\s*\)\s*\{?\s*(switch|if)\s*\(/.test(content);
        return {
          src: s.src || null,
          type: s.type || null,
          isInline: !s.src,
          contentLength: content.length,
          hasVMPattern,
        };
      });

      // 获取 Performance 网络请求
      const networkRequests: Array<{
        name: string;
        initiatorType: string;
        duration: number;
        transferSize: number;
      }> = [];
      try {
        const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
        // 取最近50条
        const recent = entries.slice(-50);
        for (const entry of recent) {
          networkRequests.push({
            name: entry.name,
            initiatorType: entry.initiatorType,
            duration: Math.round(entry.duration),
            transferSize: entry.transferSize || 0,
          });
        }
      } catch { /* Performance API 不可用 */ }

      // 获取 meta 标签
      const metaTags = document.querySelectorAll('meta');
      const meta: Record<string, string> = {};
      metaTags.forEach((m) => {
        const name = m.getAttribute('name') || m.getAttribute('property')
          || m.getAttribute('http-equiv') || m.getAttribute('id');
        const content = m.getAttribute('content');
        if (name && content) {
          meta[name] = content;
        }
        // 处理 charset meta（如 <meta charset="utf-8">）
        const charset = m.getAttribute('charset');
        if (charset) {
          meta['charset'] = charset;
        }
      });

      return {
        localStorage: ls,
        sessionStorage: ss,
        scripts,
        networkRequests,
        meta,
      };
    },
    world: 'MAIN' as chrome.scripting.ExecutionWorld,
  });

  const data = results?.[0]?.result;
  if (!data) {
    return {
      localStorage: {},
      sessionStorage: {},
      scripts: [],
      networkRequests: [],
      meta: {},
    };
  }

  return data;
}
