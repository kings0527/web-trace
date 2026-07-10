export interface TargetTabInput {
  tabId?: number;
  url?: string;
}

export interface TabSummary {
  id: number;
  windowId: number;
  index: number;
  url: string;
  title: string;
  active: boolean;
  highlighted: boolean;
  pinned: boolean;
  status: string;
  incognito: boolean;
  audible: boolean;
  discarded: boolean;
  lastFocusedWindow: boolean;
}

export function isRestrictedUrl(url?: string): boolean {
  return /^(chrome|edge|devtools|chrome-extension):\/\//i.test(url || '');
}

export function tabToSummary(
  tab: chrome.tabs.Tab,
  lastFocusedWindowId?: number,
): TabSummary {
  return {
    id: tab.id ?? -1,
    windowId: tab.windowId,
    index: tab.index,
    url: tab.url || '',
    title: tab.title || '',
    active: Boolean(tab.active),
    highlighted: Boolean(tab.highlighted),
    pinned: Boolean(tab.pinned),
    status: tab.status || '',
    incognito: Boolean(tab.incognito),
    audible: Boolean(tab.audible),
    discarded: Boolean(tab.discarded),
    lastFocusedWindow: tab.windowId === lastFocusedWindowId,
  };
}

export async function getLastFocusedWindowId(): Promise<number | undefined> {
  try {
    const win = await chrome.windows.getLastFocused();
    return win.id;
  } catch {
    return undefined;
  }
}

export async function listTabSummaries(
  includeRestricted = true,
): Promise<TabSummary[]> {
  const lastFocusedWindowId = await getLastFocusedWindowId();
  const tabs = await chrome.tabs.query({});
  return tabs
    .filter((tab) => includeRestricted || !isRestrictedUrl(tab.url))
    .map((tab) => tabToSummary(tab, lastFocusedWindowId));
}

export async function resolveTargetTab(args: TargetTabInput = {}): Promise<chrome.tabs.Tab> {
  if (args.tabId !== undefined) {
    const tab = await chrome.tabs.get(args.tabId);
    if (!tab?.id) {
      throw new Error(`Tab not found: ${args.tabId}`);
    }
    return tab;
  }

  if (args.url) {
    const tabs = await chrome.tabs.query({});
    const matchingTabs = tabs.filter((tab) => {
      const tabUrl = tab.url || '';
      return tabUrl === args.url || tabUrl.startsWith(args.url || '');
    });

    if (matchingTabs.length === 0) {
      throw new Error(`No tab found matching URL: ${args.url}`);
    }

    const lastFocusedWindowId = await getLastFocusedWindowId();
    return (
      matchingTabs.find((tab) => tab.active && tab.windowId === lastFocusedWindowId)
      || matchingTabs.find((tab) => tab.active)
      || matchingTabs[0]
    );
  }

  const lastFocusedWindowId = await getLastFocusedWindowId();
  if (lastFocusedWindowId !== undefined) {
    const [focusedActiveTab] = await chrome.tabs.query({
      active: true,
      windowId: lastFocusedWindowId,
    });
    if (focusedActiveTab?.id) {
      return focusedActiveTab;
    }
  }

  const [currentActiveTab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (currentActiveTab?.id) {
    return currentActiveTab;
  }

  const [anyActiveTab] = await chrome.tabs.query({ active: true });
  if (anyActiveTab?.id) {
    return anyActiveTab;
  }

  throw new Error('No active tab found');
}

export function assertScriptableTab(
  tab: chrome.tabs.Tab,
): asserts tab is chrome.tabs.Tab & { id: number; url: string } {
  if (!tab.id || !tab.url) {
    throw new Error('Target tab has no ID or URL');
  }
  if (isRestrictedUrl(tab.url)) {
    throw new Error(`Cannot access browser-internal URL: ${tab.url}`);
  }
}

export async function isIncognitoAccessAllowed(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      chrome.extension.isAllowedIncognitoAccess(resolve);
    } catch {
      resolve(false);
    }
  });
}
