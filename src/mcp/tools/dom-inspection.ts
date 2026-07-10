/**
 * MCP Tools: DOM inspection
 */

import { z } from 'zod';
import {
  assertScriptableTab,
  resolveTargetTab,
  tabToSummary,
  type TargetTabInput,
  type TabSummary,
} from './tab-utils';

export const domSnapshotInputSchema = {
  tabId: z.number().int().nonnegative().optional().describe('目标标签页 ID。'),
  url: z.string().url().optional().describe('目标标签页 URL，可传完整 URL 或前缀。'),
  includeHidden: z.boolean().optional().describe('是否包含不可见元素。默认 false。'),
  maxTextLength: z.number().int().min(100).max(100000).optional().describe(
    '返回页面可见文本的最大长度。默认 20000。',
  ),
  maxElements: z.number().int().min(10).max(1000).optional().describe(
    '每类元素最多返回数量。默认 200。',
  ),
};

export const queryDomInputSchema = {
  selector: z.string().min(1).describe('CSS 选择器。'),
  tabId: z.number().int().nonnegative().optional().describe('目标标签页 ID。'),
  url: z.string().url().optional().describe('目标标签页 URL，可传完整 URL 或前缀。'),
  includeHidden: z.boolean().optional().describe('是否返回不可见元素。默认 true。'),
  limit: z.number().int().min(1).max(500).optional().describe('最多返回元素数量。默认 50。'),
  includeOuterHTML: z.boolean().optional().describe('是否返回 outerHTML 截断片段。默认 false。'),
  maxOuterHTMLLength: z.number().int().min(100).max(20000).optional().describe(
    '单个 outerHTML 最大长度。默认 2000。',
  ),
};

export const domSnapshotMeta = {
  name: 'dom_snapshot',
  description: `读取目标标签页的 DOM 快照。

返回页面可见文本、表单字段、按钮、链接和表单 action/method。
默认不返回用户输入值，适合定位登录/注册入口、按钮、链接和表单结构。`,
};

export const queryDomMeta = {
  name: 'query_dom',
  description: '按 CSS 选择器读取目标标签页 DOM 节点的文本、属性、可见性和可选 outerHTML。',
};

export interface DomSnapshotInput extends TargetTabInput {
  includeHidden?: boolean;
  maxTextLength?: number;
  maxElements?: number;
}

export interface QueryDomInput extends TargetTabInput {
  selector: string;
  includeHidden?: boolean;
  limit?: number;
  includeOuterHTML?: boolean;
  maxOuterHTMLLength?: number;
}

interface RectInfo {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface FieldInfo {
  tag: string;
  type: string;
  id: string;
  name: string;
  placeholder: string;
  ariaLabel: string;
  role: string;
  labels: string[];
  disabled: boolean;
  required: boolean;
  checked?: boolean;
  valueLength?: number;
  displayValue?: string;
  visible: boolean;
}

interface LinkInfo {
  text: string;
  href: string;
  id: string;
  className: string;
  title: string;
  target: string;
  role: string;
  visible: boolean;
}

interface ButtonInfo {
  text: string;
  tag: string;
  type: string;
  id: string;
  name: string;
  ariaLabel: string;
  role: string;
  disabled: boolean;
  visible: boolean;
}

interface FormInfo {
  id: string;
  name: string;
  action: string;
  method: string;
}

interface QueriedElement {
  tag: string;
  id: string;
  className: string;
  text: string;
  attributes: Record<string, string>;
  visible: boolean;
  rect: RectInfo;
  outerHTML?: string;
}

export interface DomSnapshotOutput {
  tab: TabSummary;
  readyState: string;
  text: string;
  textTruncated: boolean;
  inputs: FieldInfo[];
  buttons: ButtonInfo[];
  links: LinkInfo[];
  forms: FormInfo[];
}

export interface QueryDomOutput {
  tab: TabSummary;
  selector: string;
  count: number;
  truncated: boolean;
  elements: QueriedElement[];
}

export async function handleDomSnapshot(
  args: DomSnapshotInput = {},
): Promise<DomSnapshotOutput> {
  const tab = await resolveTargetTab(args);
  assertScriptableTab(tab);

  const includeHidden = args.includeHidden ?? false;
  const maxTextLength = args.maxTextLength ?? 20000;
  const maxElements = args.maxElements ?? 200;

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    args: [includeHidden, maxTextLength, maxElements],
    func: (includeHiddenArg: boolean, maxTextLengthArg: number, maxElementsArg: number) => {
      function truncate(value: string, maxLength: number): string {
        return value.length > maxLength ? value.slice(0, maxLength) : value;
      }

      function textOf(el: Element | null, maxLength = 500): string {
        if (!el) return '';
        const value = ((el as HTMLElement).innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
        return truncate(value, maxLength);
      }

      function visible(el: Element): boolean {
        const htmlEl = el as HTMLElement;
        for (let current: Element | null = el; current; current = current.parentElement) {
          const currentEl = current as HTMLElement;
          if (currentEl.hidden) return false;

          const style = getComputedStyle(currentEl);
          if (
            style.display === 'none'
            || style.visibility === 'hidden'
            || style.visibility === 'collapse'
            || Number.parseFloat(style.opacity) === 0
          ) {
            return false;
          }
        }

        const rect = htmlEl.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }

      function labelsFor(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): string[] {
        const labels = 'labels' in el && el.labels ? Array.from(el.labels) : [];
        return labels.map((label) => textOf(label, 200)).filter(Boolean);
      }

      function keep<T extends Element>(items: T[]): T[] {
        return items
          .filter((el) => includeHiddenArg || visible(el))
          .slice(0, maxElementsArg);
      }

      const rawText = document.body?.innerText || document.documentElement?.innerText || '';
      const text = truncate(rawText.replace(/\s+/g, ' ').trim(), maxTextLengthArg);

      const fields = keep(Array.from(document.querySelectorAll('input, textarea, select')))
        .map((el) => {
          const field = el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
          const input = el as HTMLInputElement;
          const type = el instanceof HTMLInputElement ? input.type || 'text' : el.tagName.toLowerCase();
          const displayValue = el instanceof HTMLInputElement
            && ['button', 'submit', 'reset'].includes(type)
            ? input.value
            : undefined;

          return {
            tag: el.tagName.toLowerCase(),
            type,
            id: field.id || '',
            name: field.name || '',
            placeholder: 'placeholder' in field ? field.placeholder || '' : '',
            ariaLabel: field.getAttribute('aria-label') || '',
            role: field.getAttribute('role') || '',
            labels: labelsFor(field),
            disabled: Boolean(field.disabled),
            required: Boolean(field.required),
            checked: el instanceof HTMLInputElement
              && ['checkbox', 'radio'].includes(type)
              ? Boolean(input.checked)
              : undefined,
            valueLength: 'value' in field ? String(field.value || '').length : undefined,
            displayValue,
            visible: visible(el),
          };
        });

      const buttons = keep(Array.from(document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"], input[type="reset"]')))
        .map((el) => {
          const input = el as HTMLInputElement;
          return {
            text: el instanceof HTMLInputElement ? input.value || '' : textOf(el, 500),
            tag: el.tagName.toLowerCase(),
            type: el instanceof HTMLInputElement || el instanceof HTMLButtonElement ? el.type || '' : '',
            id: (el as HTMLElement).id || '',
            name: 'name' in el ? String((el as HTMLInputElement).name || '') : '',
            ariaLabel: el.getAttribute('aria-label') || '',
            role: el.getAttribute('role') || '',
            disabled: 'disabled' in el ? Boolean((el as HTMLButtonElement | HTMLInputElement).disabled) : false,
            visible: visible(el),
          };
        });

      const links = keep(Array.from(document.querySelectorAll('a[href]')))
        .map((el) => {
          const link = el as HTMLAnchorElement;
          return {
            text: textOf(link, 500),
            href: link.href || link.getAttribute('href') || '',
            id: link.id || '',
            className: link.className || '',
            title: link.title || '',
            target: link.target || '',
            role: link.getAttribute('role') || '',
            visible: visible(link),
          };
        });

      const forms = Array.from(document.forms).slice(0, maxElementsArg).map((form) => ({
        id: form.id || '',
        name: form.name || '',
        action: form.action || '',
        method: form.method || '',
      }));

      return {
        readyState: document.readyState,
        text,
        textTruncated: rawText.length > maxTextLengthArg,
        inputs: fields,
        buttons,
        links,
        forms,
      };
    },
    world: 'MAIN' as chrome.scripting.ExecutionWorld,
  });

  const data = results?.[0]?.result;
  if (!data) {
    throw new Error('DOM snapshot returned no data');
  }

  return {
    tab: tabToSummary(tab),
    ...data,
  };
}

export async function handleQueryDom(args: QueryDomInput): Promise<QueryDomOutput> {
  const tab = await resolveTargetTab(args);
  assertScriptableTab(tab);

  const includeHidden = args.includeHidden ?? true;
  const limit = args.limit ?? 50;
  const includeOuterHTML = args.includeOuterHTML ?? false;
  const maxOuterHTMLLength = args.maxOuterHTMLLength ?? 2000;

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    args: [args.selector, includeHidden, limit, includeOuterHTML, maxOuterHTMLLength],
    func: (
      selectorArg: string,
      includeHiddenArg: boolean,
      limitArg: number,
      includeOuterHTMLArg: boolean,
      maxOuterHTMLLengthArg: number,
    ) => {
      function truncate(value: string, maxLength: number): string {
        return value.length > maxLength ? value.slice(0, maxLength) : value;
      }

      function textOf(el: Element): string {
        return truncate(((el as HTMLElement).innerText || el.textContent || '').replace(/\s+/g, ' ').trim(), 1000);
      }

      function visible(el: Element): boolean {
        const htmlEl = el as HTMLElement;
        for (let current: Element | null = el; current; current = current.parentElement) {
          const currentEl = current as HTMLElement;
          if (currentEl.hidden) return false;

          const style = getComputedStyle(currentEl);
          if (
            style.display === 'none'
            || style.visibility === 'hidden'
            || style.visibility === 'collapse'
            || Number.parseFloat(style.opacity) === 0
          ) {
            return false;
          }
        }

        const rect = htmlEl.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }

      function rectOf(el: Element) {
        const rect = el.getBoundingClientRect();
        return {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      }

      function attrsOf(el: Element): Record<string, string> {
        const allowed = new Set([
          'href', 'src', 'type', 'name', 'placeholder', 'aria-label',
          'role', 'title', 'alt', 'value',
        ]);
        const attrs: Record<string, string> = {};
        for (const attr of Array.from(el.attributes)) {
          if (!allowed.has(attr.name)) continue;
          if (attr.name === 'value' && !['button', 'submit', 'reset'].includes((el as HTMLInputElement).type || '')) {
            attrs.valueLength = String(attr.value || '').length.toString();
            continue;
          }
          attrs[attr.name] = attr.value;
        }
        return attrs;
      }

      const all = Array.from(document.querySelectorAll(selectorArg));
      const filtered = all.filter((el) => includeHiddenArg || visible(el));
      const selected = filtered.slice(0, limitArg);

      return {
        count: filtered.length,
        truncated: filtered.length > selected.length,
        elements: selected.map((el) => ({
          tag: el.tagName.toLowerCase(),
          id: (el as HTMLElement).id || '',
          className: (el as HTMLElement).className || '',
          text: textOf(el),
          attributes: attrsOf(el),
          visible: visible(el),
          rect: rectOf(el),
          outerHTML: includeOuterHTMLArg
            ? truncate((el as HTMLElement).outerHTML || '', maxOuterHTMLLengthArg)
            : undefined,
        })),
      };
    },
    world: 'MAIN' as chrome.scripting.ExecutionWorld,
  });

  const data = results?.[0]?.result;
  if (!data) {
    throw new Error(`DOM query returned no data for selector: ${args.selector}`);
  }

  return {
    tab: tabToSummary(tab),
    selector: args.selector,
    ...data,
  };
}
