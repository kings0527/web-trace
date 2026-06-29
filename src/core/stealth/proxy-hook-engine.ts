/**
 * Proxy Hook Engine - 通用函数Hook框架
 * 支持Hook任意全局函数/方法，同时隐藏Hook痕迹
 *
 * 设计要点：
 * - 使用Proxy的apply trap拦截函数调用
 * - toString修补在任何其他Hook之前执行
 * - 被Hook函数的name、length属性保持原始值
 * - 支持链式Hook（多个handler叠加）
 * - 支持unhook恢复原始函数
 */

/** Hook handler 类型定义 */
export type HookHandler = (
  originalFn: Function,
  thisArg: unknown,
  args: unknown[]
) => unknown;

/** Hook 记录 */
interface HookRecord {
  target: object;
  property: string;
  originalFn: Function;
  originalDescriptor: PropertyDescriptor | undefined;
  handlers: HookHandler[];
  proxy: Function;
}

/**
 * 通用 Proxy Hook 引擎
 * 提供函数级别的透明Hook能力，同时隐藏所有Hook痕迹
 */
export class ProxyHookEngine {
  /** 记录所有被Hook的函数引用，用于toString修补判断 */
  private hookedFunctions: WeakSet<Function> = new WeakSet();

  /** Hook路径 → 记录映射 */
  private hookRecords: Map<string, HookRecord> = new Map();

  /** 原始toString引用 */
  private originalToString: Function;
  private originalCall: Function;
  private originalGetOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor;
  private originalGetOwnPropertyNames: typeof Object.getOwnPropertyNames;
  private originalReflectOwnKeys: typeof Reflect.ownKeys;
  private originalDefineProperty: typeof Object.defineProperty;

  /** 是否已初始化（幂等保护） */
  private initialized = false;

  /** 新增的属性名记录（用于隐藏） */
  private hiddenProperties: Map<object, Set<string | symbol>> = new Map();

  constructor() {
    // 保存所有原始引用
    this.originalToString = Function.prototype.toString;
    this.originalCall = Function.prototype.call;
    this.originalGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
    this.originalGetOwnPropertyNames = Object.getOwnPropertyNames;
    this.originalReflectOwnKeys = Reflect.ownKeys;
    this.originalDefineProperty = Object.defineProperty;
  }

  /**
   * 初始化引擎 - 修补所有检测点
   * 必须在任何hook操作之前调用
   */
  public init(): void {
    if (this.initialized) return;
    this.initialized = true;

    this.patchToString();
    this.patchDescriptor();
    this.patchOwnKeys();
  }

  /**
   * Hook指定对象上的方法
   * @param target - 目标对象（如window、navigator等）
   * @param property - 属性名（如'fetch'、'now'等）
   * @param handler - Hook处理函数
   */
  public hook(target: object, property: string, handler: HookHandler): void {
    if (!this.initialized) {
      this.init();
    }

    const key = this.getKey(target, property);
    const existing = this.hookRecords.get(key);

    if (existing) {
      // 链式Hook：追加handler
      existing.handlers.push(handler);
      return;
    }

    const descriptor = this.originalGetOwnPropertyDescriptor.call(
      Object,
      target,
      property
    );
    const originalFn = (target as Record<string, unknown>)[property] as Function;

    if (typeof originalFn !== 'function') {
      return;
    }

    // 创建Proxy，使用apply trap
    const self = this;
    const handlers: HookHandler[] = [handler];

    const proxy = new Proxy(originalFn, {
      apply(_proxyTarget, thisArg, argArray) {
        // 依次执行handler链，最后一个handler的返回值为最终结果
        let result: unknown;
        for (let i = 0; i < handlers.length; i++) {
          result = handlers[i](originalFn, thisArg, argArray);
        }
        return result;
      },
      get(proxyTarget, prop, receiver) {
        // 保持name和length属性与原始函数一致
        if (prop === 'name') return originalFn.name;
        if (prop === 'length') return originalFn.length;
        if (prop === 'prototype') return originalFn.prototype;
        return Reflect.get(proxyTarget, prop, receiver);
      },
    });

    // 标记为已hook
    this.hookedFunctions.add(proxy);

    // 替换属性
    const newDescriptor: PropertyDescriptor = {
      value: proxy,
      writable: descriptor?.writable ?? true,
      enumerable: descriptor?.enumerable ?? true,
      configurable: descriptor?.configurable ?? true,
    };
    this.originalDefineProperty.call(Object, target, property, newDescriptor);

    // 记录
    const record: HookRecord = {
      target,
      property,
      originalFn,
      originalDescriptor: descriptor,
      handlers,
      proxy,
    };
    this.hookRecords.set(key, record);
  }

  /**
   * 取消Hook，恢复原始函数
   * @param target - 目标对象
   * @param property - 属性名
   */
  public unhook(target: object, property: string): void {
    const key = this.getKey(target, property);
    const record = this.hookRecords.get(key);

    if (!record) return;

    // 恢复原始属性
    if (record.originalDescriptor) {
      this.originalDefineProperty.call(
        Object,
        target,
        property,
        record.originalDescriptor
      );
    } else {
      (target as Record<string, unknown>)[property] = record.originalFn;
    }

    // 清理引用
    this.hookedFunctions.delete(record.proxy);
    this.hookRecords.delete(key);
  }

  /**
   * 取消所有Hook
   */
  public unhookAll(): void {
    for (const [_key, record] of this.hookRecords) {
      if (record.originalDescriptor) {
        this.originalDefineProperty.call(
          Object,
          record.target,
          record.property,
          record.originalDescriptor
        );
      } else {
        (record.target as Record<string, unknown>)[record.property] =
          record.originalFn;
      }
      this.hookedFunctions.delete(record.proxy);
    }
    this.hookRecords.clear();
  }

  /**
   * 标记目标对象上需要隐藏的属性
   */
  public hideProperty(target: object, property: string | symbol): void {
    let props = this.hiddenProperties.get(target);
    if (!props) {
      props = new Set();
      this.hiddenProperties.set(target, props);
    }
    props.add(property);
  }

  /**
   * 修补 Function.prototype.toString
   * 使被Hook的函数返回原生代码格式
   */
  private patchToString(): void {
    const self = this;
    const origToString = this.originalToString;

    // 替换toString
    const patchedToString = function (this: Function): string {
      // 如果是被hook的函数，返回native code格式
      if (self.hookedFunctions.has(this)) {
        // 查找原始函数名
        for (const record of self.hookRecords.values()) {
          if (record.proxy === this) {
            return `function ${record.originalFn.name || ''}() { [native code] }`;
          }
        }
        return `function () { [native code] }`;
      }
      // 如果是patchedToString自身被检测
      if (this === patchedToString) {
        return `function toString() { [native code] }`;
      }
      return origToString.call(this);
    };

    // 标记patchedToString自身
    this.hookedFunctions.add(patchedToString);

    this.originalDefineProperty.call(Object, Function.prototype, 'toString', {
      value: patchedToString,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }

  /**
   * 修补 Object.getOwnPropertyDescriptor
   * 使被Hook属性的描述符保持原始状态
   */
  private patchDescriptor(): void {
    const self = this;
    const origGetDescriptor = this.originalGetOwnPropertyDescriptor;

    const patchedGetDescriptor = function (
      target: object,
      property: string | symbol
    ): PropertyDescriptor | undefined {
      if (typeof property === 'string') {
        const key = self.getKey(target, property);
        const record = self.hookRecords.get(key);
        if (record && record.originalDescriptor) {
          // 返回伪造的原始描述符
          return {
            ...record.originalDescriptor,
            value: record.proxy,
          };
        }
      }
      return origGetDescriptor.call(Object, target, property as string);
    };

    this.hookedFunctions.add(patchedGetDescriptor as unknown as Function);
    this.originalDefineProperty.call(Object, Object, 'getOwnPropertyDescriptor', {
      value: patchedGetDescriptor,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }

  /**
   * 修补 Object.getOwnPropertyNames 和 Reflect.ownKeys
   * 隐藏新增的属性
   */
  private patchOwnKeys(): void {
    const self = this;
    const origGetOwnPropertyNames = this.originalGetOwnPropertyNames;
    const origReflectOwnKeys = this.originalReflectOwnKeys;

    // Patch Object.getOwnPropertyNames
    const patchedGetOwnPropertyNames = function (target: object): string[] {
      const names = origGetOwnPropertyNames.call(Object, target);
      const hidden = self.hiddenProperties.get(target);
      if (hidden) {
        return names.filter((n) => !hidden.has(n));
      }
      return names;
    };

    this.hookedFunctions.add(patchedGetOwnPropertyNames as unknown as Function);
    this.originalDefineProperty.call(Object, Object, 'getOwnPropertyNames', {
      value: patchedGetOwnPropertyNames,
      writable: true,
      enumerable: false,
      configurable: true,
    });

    // Patch Reflect.ownKeys
    const patchedReflectOwnKeys = function (target: object): (string | symbol)[] {
      const keys = origReflectOwnKeys.call(Reflect, target);
      const hidden = self.hiddenProperties.get(target);
      if (hidden) {
        return keys.filter((k) => !hidden.has(k));
      }
      return keys;
    };

    this.hookedFunctions.add(patchedReflectOwnKeys as unknown as Function);
    this.originalDefineProperty.call(Object, Reflect, 'ownKeys', {
      value: patchedReflectOwnKeys,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }

  /**
   * 生成唯一key用于记录映射
   */
  private getKey(target: object, property: string): string {
    // 使用一些特征来识别target
    const targetName =
      (target as { constructor?: { name?: string } })?.constructor?.name || 'Object';
    return `${targetName}::${property}`;
  }
}

/** 全局单例 */
export const proxyHookEngine = new ProxyHookEngine();
