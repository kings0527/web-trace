/**
 * MCP Tools: browser tab control
 */

import { z } from 'zod';
import {
  getLastFocusedWindowId,
  isIncognitoAccessAllowed,
  listTabSummaries,
  resolveTargetTab,
  tabToSummary,
  type TabSummary,
} from './tab-utils';

export const listTabsInputSchema = {
  includeRestricted: z.boolean().optional().describe(
    '是否包含 chrome://、edge:// 等浏览器内部页面。默认 false。',
  ),
};

export const activateTabInputSchema = {
  tabId: z.number().int().nonnegative().describe('要激活的标签页 ID。'),
  focusWindow: z.boolean().optional().describe('是否同时聚焦标签页所在窗口。默认 true。'),
};

export const navigateInputSchema = {
  url: z.string().url().describe('要打开或导航到的 URL。'),
  tabId: z.number().int().nonnegative().optional().describe(
    '目标标签页 ID。省略时默认使用当前活跃标签页，或在 newTab=true 时新建标签页。',
  ),
  windowId: z.number().int().optional().describe('新建标签页时使用的窗口 ID。'),
  newTab: z.boolean().optional().describe('是否新建标签页。默认 false。'),
  active: z.boolean().optional().describe('导航后是否激活标签页。默认 true。'),
  incognito: z.boolean().optional().describe(
    'newTab=true 时是否优先在隐身窗口打开。需要浏览器允许扩展在隐身模式运行。',
  ),
};

export const listTabsMeta = {
  name: 'list_tabs',
  description: `列出当前浏览器所有标签页。

返回 tabId、windowId、URL、标题、active、incognito、lastFocusedWindow 等字段。
用于在多标签页或隐身窗口中选择要分析的目标页面。`,
};

export const activateTabMeta = {
  name: 'activate_tab',
  description: '激活指定 tabId 的标签页，并可聚焦其所在窗口。',
};

export const navigateMeta = {
  name: 'navigate',
  description: `在当前标签页、指定 tabId 或新标签页中打开 URL。

可配合 list_tabs 获取 tabId；newTab=true 且 incognito=true 时会优先使用隐身窗口。`,
};

export interface ListTabsInput {
  includeRestricted?: boolean;
}

export interface ListTabsOutput {
  tabs: TabSummary[];
  tabCount: number;
  activeTabId?: number;
  lastFocusedWindowId?: number;
  incognitoAccessAllowed: boolean;
}

export interface ActivateTabInput {
  tabId: number;
  focusWindow?: boolean;
}

export interface ActivateTabOutput {
  tab: TabSummary;
}

export interface NavigateInput {
  url: string;
  tabId?: number;
  windowId?: number;
  newTab?: boolean;
  active?: boolean;
  incognito?: boolean;
}

export interface NavigateOutput {
  tab: TabSummary;
  createdWindowId?: number;
}

export async function handleListTabs(args: ListTabsInput = {}): Promise<ListTabsOutput> {
  const tabs = await listTabSummaries(args.includeRestricted ?? false);
  const lastFocusedWindowId = await getLastFocusedWindowId();
  const activeTab = tabs.find((tab) => tab.active && tab.lastFocusedWindow)
    || tabs.find((tab) => tab.active);

  return {
    tabs,
    tabCount: tabs.length,
    activeTabId: activeTab?.id,
    lastFocusedWindowId,
    incognitoAccessAllowed: await isIncognitoAccessAllowed(),
  };
}

export async function handleActivateTab(args: ActivateTabInput): Promise<ActivateTabOutput> {
  const tab = await chrome.tabs.update(args.tabId, { active: true });
  if (!tab?.id) {
    throw new Error(`Tab not found: ${args.tabId}`);
  }

  if (args.focusWindow !== false && tab.windowId !== undefined) {
    await chrome.windows.update(tab.windowId, { focused: true });
  }

  return {
    tab: tabToSummary(tab, await getLastFocusedWindowId()),
  };
}

export async function handleNavigate(args: NavigateInput): Promise<NavigateOutput> {
  const active = args.active ?? true;
  let createdWindowId: number | undefined;
  let tab: chrome.tabs.Tab | undefined;

  if (args.newTab) {
    if (args.incognito) {
      const windows = await chrome.windows.getAll({ populate: false });
      const targetWindow = args.windowId !== undefined
        ? windows.find((win) => win.id === args.windowId)
        : windows.find((win) => win.incognito);

      if (targetWindow?.id) {
        tab = await chrome.tabs.create({
          url: args.url,
          active,
          windowId: targetWindow.id,
        });
      } else {
        const win = await chrome.windows.create({
          url: args.url,
          incognito: true,
          focused: active,
        });
        createdWindowId = win.id;
        tab = win.tabs?.[0];
      }
    } else {
      tab = await chrome.tabs.create({
        url: args.url,
        active,
        windowId: args.windowId,
      });
    }
  } else {
    const targetTab = args.tabId !== undefined
      ? await chrome.tabs.get(args.tabId)
      : await resolveTargetTab();
    if (!targetTab?.id) {
      throw new Error('No target tab found for navigation');
    }
    tab = await chrome.tabs.update(targetTab.id, { url: args.url, active });
  }

  if (!tab?.id) {
    throw new Error(`Navigation did not return a tab for URL: ${args.url}`);
  }

  if (active && tab.windowId !== undefined) {
    await chrome.windows.update(tab.windowId, { focused: true });
  }

  return {
    tab: tabToSummary(tab, await getLastFocusedWindowId()),
    createdWindowId,
  };
}
