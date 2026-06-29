/**
 * Extension Hider - 隐藏Chrome Extension自身存在
 * 防止页面JS通过chrome.runtime等API检测到Extension
 *
 * 功能：
 * 1. Hook chrome.runtime.id → 返回undefined
 * 2. Hook chrome.runtime.sendMessage → 返回noop/undefined
 * 3. Hook chrome.runtime.connect → 直接block
 * 4. Hook chrome.runtime.getURL → 移除extension://特征
 * 5. 隐藏chrome.runtime.getManifest
 * 6. 清除注入script标签的sourceURL标记
 */

/** 是否已执行过隐藏（幂等保护） */
let installed = false;

/**
 * 隐藏Extension自身存在
 * 重写chrome.runtime相关API，确保修改不可被Object.getOwnPropertyDescriptor检测
 */
export function hideExtension(): void {
  if (installed) return;
  installed = true;

  // 在非Chrome环境（如Node.js测试）中直接返回
  if (typeof globalThis === 'undefined') return;

  const win = globalThis as unknown as Window & {
    chrome?: {
      runtime?: Record<string, unknown>;
      [key: string]: unknown;
    };
  };

  // chrome对象可能不存在（非Chrome浏览器环境）
  if (!win.chrome) return;

  // 保存原始引用
  const originalRuntime = win.chrome.runtime;
  if (!originalRuntime) return;

  const originalDefineProperty = Object.defineProperty;
  const originalGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;

  // ==========================================
  // 1. Hook chrome.runtime.id → 返回undefined
  // ==========================================
  overrideProperty(originalRuntime, 'id', {
    get() {
      return undefined;
    },
    set() {
      // noop
    },
    enumerable: true,
    configurable: true,
  });

  // ==========================================
  // 2. Hook chrome.runtime.sendMessage → noop
  // ==========================================
  overrideProperty(originalRuntime, 'sendMessage', {
    value: createNativeFunction('sendMessage', function () {
      return undefined;
    }),
    writable: true,
    enumerable: true,
    configurable: true,
  });

  // ==========================================
  // 3. Hook chrome.runtime.connect → block
  // ==========================================
  overrideProperty(originalRuntime, 'connect', {
    value: createNativeFunction('connect', function () {
      // 模拟未安装extension时的行为：返回一个虚假port
      return {
        name: '',
        disconnect() {},
        onDisconnect: { addListener() {}, removeListener() {}, hasListeners() { return false; } },
        onMessage: { addListener() {}, removeListener() {}, hasListeners() { return false; } },
        postMessage() {},
      };
    }),
    writable: true,
    enumerable: true,
    configurable: true,
  });

  // ==========================================
  // 4. Hook chrome.runtime.getURL → 移除extension://特征
  // ==========================================
  overrideProperty(originalRuntime, 'getURL', {
    value: createNativeFunction('getURL', function (_path?: string) {
      // 伪装成不存在的行为
      return '';
    }),
    writable: true,
    enumerable: true,
    configurable: true,
  });

  // ==========================================
  // 5. 隐藏chrome.runtime.getManifest
  // ==========================================
  overrideProperty(originalRuntime, 'getManifest', {
    value: createNativeFunction('getManifest', function () {
      return undefined;
    }),
    writable: true,
    enumerable: true,
    configurable: true,
  });

  // ==========================================
  // 6. 清除注入script标签的sourceURL标记
  // ==========================================
  cleanInjectedScripts();

  // 设置MutationObserver持续清除新注入的script
  installScriptObserver();

  /**
   * 安全覆盖属性，使其不可被getOwnPropertyDescriptor检测
   */
  function overrideProperty(
    target: Record<string, unknown>,
    prop: string,
    descriptor: PropertyDescriptor
  ): void {
    try {
      originalDefineProperty.call(Object, target, prop, descriptor);
    } catch {
      // 某些只读属性可能无法覆盖，静默处理
    }
  }

  /**
   * 创建伪装成native code的函数
   */
  function createNativeFunction(name: string, fn: Function): Function {
    // 设置函数name属性
    originalDefineProperty.call(Object, fn, 'name', {
      value: name,
      writable: false,
      enumerable: false,
      configurable: true,
    });

    // 覆盖toString使其返回native code格式
    originalDefineProperty.call(Object, fn, 'toString', {
      value: function () {
        return `function ${name}() { [native code] }`;
      },
      writable: true,
      enumerable: false,
      configurable: true,
    });

    return fn;
  }

  /**
   * 清除已存在的带有extension特征的script标签
   */
  function cleanInjectedScripts(): void {
    if (typeof document === 'undefined') return;

    try {
      const scripts = document.querySelectorAll('script');
      scripts.forEach((script) => {
        cleanScriptElement(script);
      });
    } catch {
      // DOM操作可能在某些环境下不可用
    }
  }

  /**
   * 清理单个script元素的extension特征
   */
  function cleanScriptElement(script: HTMLScriptElement): void {
    // 移除src中的chrome-extension://引用
    if (script.src && script.src.includes('chrome-extension://')) {
      script.removeAttribute('src');
    }

    // 清理内联脚本中的sourceURL标记
    if (script.textContent) {
      const sourceURLPattern = /\/\/[#@]\s*sourceURL\s*=\s*chrome-extension:\/\/[^\n]*/g;
      if (sourceURLPattern.test(script.textContent)) {
        script.textContent = script.textContent.replace(sourceURLPattern, '');
      }
    }
  }

  /**
   * 安装MutationObserver监控新注入的script标签
   */
  function installScriptObserver(): void {
    if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') {
      return;
    }

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (
            node instanceof HTMLScriptElement
          ) {
            cleanScriptElement(node);
          }
        }
      }
    });

    // 在document可用时启动观察
    const startObserving = () => {
      observer.observe(document.documentElement || document.body, {
        childList: true,
        subtree: true,
      });
    };

    if (document.documentElement) {
      startObserving();
    } else {
      // DOM还未就绪时延迟启动
      document.addEventListener('DOMContentLoaded', startObserving, { once: true });
    }
  }
}
