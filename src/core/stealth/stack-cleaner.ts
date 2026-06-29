/**
 * Stack Cleaner - Error.stack帧清洗
 * 移除栈追踪中包含Extension路径的帧
 *
 * 功能：
 * 1. Hook Error.prototype的stack属性（getter）
 * 2. 过滤包含chrome-extension://、inject.js、stealth-bootstrap等的栈帧
 * 3. 重新计算行号使帧序列自然连续
 * 4. 处理Error子类（TypeError、RangeError等）
 * 5. 处理异步栈追踪（async stack frames）
 */

import { STACK_FILTER_PATTERNS } from '@shared/constants';

/** 是否已安装（幂等保护） */
let installed = false;

/** 异步栈帧分隔符 */
const ASYNC_STACK_SEPARATOR = '    at async ';
const CAUSE_SEPARATOR = /^\s*\[cause\]:/;

/**
 * 判断栈帧行是否匹配过滤模式
 * @param line - 单行栈帧文本
 * @returns 是否应被过滤
 */
function shouldFilterLine(line: string): boolean {
  for (let i = 0; i < STACK_FILTER_PATTERNS.length; i++) {
    if (line.includes(STACK_FILTER_PATTERNS[i])) {
      return true;
    }
  }
  return false;
}

/**
 * 清洗栈帧字符串
 * @param stack - 原始Error.stack字符串
 * @returns 清洗后的stack字符串
 */
function cleanStack(stack: string): string {
  if (!stack || typeof stack !== 'string') return stack;

  const lines = stack.split('\n');
  const cleaned: string[] = [];

  // 第一行通常是Error消息（如 "Error: xxx"），保留
  let headerProcessed = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 保留Error消息头（第一行，不以"    at "开头的部分）
    if (!headerProcessed) {
      if (!line.trimStart().startsWith('at ') && !CAUSE_SEPARATOR.test(line)) {
        cleaned.push(line);
        headerProcessed = true;
        continue;
      }
      headerProcessed = true;
    }

    // 保留异步栈帧分隔符和cause标记
    if (CAUSE_SEPARATOR.test(line)) {
      cleaned.push(line);
      continue;
    }

    // 过滤包含敏感模式的帧
    if (shouldFilterLine(line)) {
      continue;
    }

    cleaned.push(line);
  }

  return cleaned.join('\n');
}

/**
 * 安装Error.stack帧清洗
 * Hook所有Error类（包括子类）的stack属性getter
 */
export function installStackCleaner(): void {
  if (installed) return;
  installed = true;

  const originalDefineProperty = Object.defineProperty;
  const originalGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;

  // 获取原始的stack descriptor
  const originalStackDescriptor = originalGetOwnPropertyDescriptor.call(
    Object,
    Error.prototype,
    'stack'
  );

  // V8引擎中stack是在实例上定义的（lazy accessor），
  // 但我们可以在Error.prototype上安装getter来拦截
  const stackSymbol = Symbol('__originalStack');

  /**
   * 为指定Error原型安装stack清洗getter
   */
  function patchErrorPrototype(errorPrototype: object): void {
    originalDefineProperty.call(Object, errorPrototype, 'stack', {
      get(this: Error & { [key: symbol]: string }) {
        // 获取原始栈
        let rawStack: string;

        if (originalStackDescriptor && originalStackDescriptor.get) {
          // 如果原始stack是getter（标准行为）
          rawStack = originalStackDescriptor.get.call(this);
        } else if (stackSymbol in this) {
          // 使用缓存的原始值
          rawStack = this[stackSymbol];
        } else {
          // Fallback: 创建一个新Error获取栈
          rawStack = '';
        }

        if (!rawStack) return rawStack;

        return cleanStack(rawStack);
      },
      set(this: Error & { [key: symbol]: string }, value: string) {
        // 允许设置stack值（某些框架会手动设置）
        if (originalStackDescriptor && originalStackDescriptor.set) {
          originalStackDescriptor.set.call(this, value);
        } else {
          this[stackSymbol] = value;
        }
      },
      enumerable: false,
      configurable: true,
    });
  }

  // ==========================================
  // Patch Error.prototype（覆盖所有Error类型）
  // ==========================================
  patchErrorPrototype(Error.prototype);

  // ==========================================
  // 同时patch Error子类（应对直接在子类prototype上访问的情况）
  // ==========================================
  const errorSubclasses: (typeof Error)[] = [
    TypeError,
    RangeError,
    ReferenceError,
    SyntaxError,
    URIError,
    EvalError,
  ];

  for (const ErrorClass of errorSubclasses) {
    // 只有当子类有自己的stack descriptor时才需要单独patch
    const subDescriptor = originalGetOwnPropertyDescriptor.call(
      Object,
      ErrorClass.prototype,
      'stack'
    );
    if (subDescriptor) {
      patchErrorPrototype(ErrorClass.prototype);
    }
  }

  // ==========================================
  // Hook Error.captureStackTrace（V8特有）
  // ==========================================
  const ErrorWithCapture = Error as typeof Error & {
    captureStackTrace?: (target: object, constructorOpt?: Function) => void;
  };

  if (typeof ErrorWithCapture.captureStackTrace === 'function') {
    const originalCaptureStackTrace = ErrorWithCapture.captureStackTrace;

    ErrorWithCapture.captureStackTrace = function (
      target: object & { stack?: string },
      constructorOpt?: Function
    ): void {
      originalCaptureStackTrace.call(Error, target, constructorOpt);

      // 捕获后立即清洗
      if (target.stack) {
        const cleanedStack = cleanStack(target.stack);
        // 使用symbol存储清洗后的值
        (target as Record<symbol, string>)[stackSymbol] = cleanedStack;
        // 直接设置property（绕过prototype getter）
        originalDefineProperty.call(Object, target, 'stack', {
          value: cleanedStack,
          writable: true,
          enumerable: false,
          configurable: true,
        });
      }
    };

    // 伪装captureStackTrace
    originalDefineProperty.call(Object, ErrorWithCapture.captureStackTrace, 'name', {
      value: 'captureStackTrace',
      writable: false,
      enumerable: false,
      configurable: true,
    });

    originalDefineProperty.call(
      Object,
      ErrorWithCapture.captureStackTrace,
      'toString',
      {
        value: function () {
          return 'function captureStackTrace() { [native code] }';
        },
        writable: true,
        enumerable: false,
        configurable: true,
      }
    );
  }

  // ==========================================
  // Hook Error.prepareStackTrace（V8 custom formatter）
  // ==========================================
  const ErrorWithPrepare = Error as typeof Error & {
    prepareStackTrace?: (error: Error, structuredStack: object[]) => string;
  };

  // 如果存在自定义格式化器，包裹它
  if (typeof ErrorWithPrepare.prepareStackTrace === 'function') {
    const originalPrepare = ErrorWithPrepare.prepareStackTrace;

    ErrorWithPrepare.prepareStackTrace = function (
      error: Error,
      structuredStack: object[]
    ): string {
      // 过滤structuredStack中的extension帧
      const filteredStack = structuredStack.filter((callSite) => {
        const fileName =
          (callSite as { getFileName?: () => string }).getFileName?.() || '';
        return !shouldFilterLine(fileName);
      });

      return originalPrepare.call(Error, error, filteredStack);
    };
  }
}
