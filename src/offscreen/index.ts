/**
 * WebTrace Offscreen Document
 * 运行WASM（QuickJS）和Babel AST分析的重计算环境
 * 独立于页面环境，通过chrome.runtime.onMessage与Service Worker通信
 *
 * 设计原则：
 * - Lazy Init: QuickJS WASM和Babel在首次使用时才加载，减少启动时间
 * - 隔离性: 此环境与页面完全隔离，可安全运行未知代码
 * - 持久性: 只要Extension存活，此document就持续运行
 */

import type { OffscreenMessage, OffscreenMessageType } from '@shared/types';

// ─── Lazy Init 状态 ───

/** QuickJS WASM 模块实例（延迟加载） */
let quickjsModule: any = null;
let quickjsInitPromise: Promise<any> | null = null;

/** Babel Parser 模块（延迟加载） */
let babelParser: any = null;
let babelTraverse: any = null;
let babelInitPromise: Promise<void> | null = null;

// ─── QuickJS WASM 初始化 ───

/**
 * 延迟初始化QuickJS WASM模块
 * 只在首次QUICKJS_EXECUTE调用时加载
 */
async function getQuickJS(): Promise<any> {
  if (quickjsModule) return quickjsModule;

  if (!quickjsInitPromise) {
    quickjsInitPromise = (async () => {
      try {
        console.log('[Offscreen] Loading QuickJS WASM...');
        const { newQuickJSWASMModuleFromVariant } = await import('quickjs-emscripten-core');
        const variant = await import('@jitl/quickjs-singlefile-browser-release-sync');
        quickjsModule = await newQuickJSWASMModuleFromVariant(variant.default);
        console.log('[Offscreen] QuickJS WASM loaded successfully');
        return quickjsModule;
      } catch (err) {
        quickjsInitPromise = null; // 允许重试
        console.error('[Offscreen] QuickJS WASM load failed:', err);
        throw err;
      }
    })();
  }

  return quickjsInitPromise;
}

// ─── Babel 初始化 ───

/**
 * 延迟初始化Babel Parser和Traverse
 * 只在首次BABEL_ANALYZE调用时加载
 */
async function getBabel(): Promise<{ parser: any; traverse: any }> {
  if (babelParser && babelTraverse) {
    return { parser: babelParser, traverse: babelTraverse };
  }

  if (!babelInitPromise) {
    babelInitPromise = (async () => {
      try {
        console.log('[Offscreen] Loading Babel...');
        const [parserMod, traverseMod] = await Promise.all([
          import('@babel/parser'),
          import('@babel/traverse'),
        ]);
        babelParser = parserMod;
        babelTraverse = traverseMod.default || traverseMod;
        console.log('[Offscreen] Babel loaded successfully');
      } catch (err) {
        babelInitPromise = null; // 允许重试
        console.error('[Offscreen] Babel load failed:', err);
        throw err;
      }
    })();
  }

  await babelInitPromise;
  return { parser: babelParser, traverse: babelTraverse };
}

// ─── 任务处理器 ───

/**
 * 处理QuickJS执行任务
 * 在WASM沙箱中执行JavaScript代码
 */
async function handleQuickJSExecute(payload: any): Promise<unknown> {
  const quickjs = await getQuickJS();

  const { code, config } = payload as {
    code: string;
    config?: { memoryLimit?: number; maxExecutionTime?: number };
  };

  const vm = quickjs.newContext();

  try {
    // 设置执行超时
    const maxTime = config?.maxExecutionTime || 30000;
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      vm.runtime.setInterruptHandler(() => true);
    }, maxTime);

    // 执行代码
    const result = vm.evalCode(code, 'user-script.js', {
      strict: true,
    });

    clearTimeout(timeoutId);

    if (timedOut) {
      if (result.error) {
        vm.runtime.removeInterruptHandler();
        result.error.dispose();
      } else {
        result.value.dispose();
      }
      throw new Error(`Execution timed out after ${maxTime}ms`);
    }

    if (result.error) {
      const errorMsg = vm.dump(result.error);
      result.error.dispose();
      throw new Error(`QuickJS execution error: ${JSON.stringify(errorMsg)}`);
    }

    const value = vm.dump(result.value);
    result.value.dispose();
    return value;
  } finally {
    vm.dispose();
  }
}

/**
 * 处理Babel AST分析任务
 * 解析并分析JavaScript源码结构
 */
async function handleBabelAnalyze(payload: any): Promise<unknown> {
  const { parser, traverse } = await getBabel();

  const { source, options } = payload as {
    source: string;
    options?: {
      detectVM?: boolean;
      extractStrings?: boolean;
      findDispatcher?: boolean;
    };
  };

  // 解析AST
  const ast = parser.parse(source, {
    sourceType: 'unambiguous',
    plugins: ['dynamicImport', 'optionalChaining', 'nullishCoalescingOperator'],
    errorRecovery: true,
  });

  const analysisResult: Record<string, unknown> = {
    type: ast.program.sourceType,
    bodyLength: ast.program.body.length,
    errors: ast.errors?.length || 0,
  };

  // VM派发循环检测
  if (options?.detectVM || options?.findDispatcher) {
    const dispatchers: Array<Record<string, unknown>> = [];

    traverse(ast, {
      WhileStatement(path: any) {
        // 查找 while(...) { switch(...) { ... } } 模式
        const body = path.node.body;
        if (body.type === 'BlockStatement' && body.body.length > 0) {
          const firstStmt = body.body[0];
          if (firstStmt.type === 'SwitchStatement') {
            dispatchers.push({
              type: 'while-switch',
              location: path.node.loc?.start || null,
              casesCount: firstStmt.cases.length,
            });
          }
        }
      },
      ForStatement(path: any) {
        // 查找 for(;;) { switch(...) } 模式
        const body = path.node.body;
        if (body.type === 'BlockStatement' && body.body.length > 0) {
          const firstStmt = body.body[0];
          if (firstStmt.type === 'SwitchStatement') {
            dispatchers.push({
              type: 'for-switch',
              location: path.node.loc?.start || null,
              casesCount: firstStmt.cases.length,
            });
          }
        }
      },
    });

    analysisResult.dispatchers = dispatchers;
    analysisResult.hasVMPattern = dispatchers.length > 0;
  }

  // 字符串提取
  if (options?.extractStrings) {
    const strings: string[] = [];
    traverse(ast, {
      StringLiteral(path: any) {
        if (path.node.value.length > 2) {
          strings.push(path.node.value);
        }
      },
    });
    analysisResult.strings = strings.slice(0, 1000); // 限制数量
  }

  return analysisResult;
}

// ─── 消息分派 ───

/**
 * 创建响应消息
 */
function createResponse(
  id: string,
  type: 'RESULT' | 'ERROR',
  payload: unknown
): OffscreenMessage {
  return { __wt: true, id, type, payload };
}

/**
 * 主消息处理器
 */
async function handleMessage(message: OffscreenMessage): Promise<void> {
  const { id, type, payload } = message;

  try {
    let result: unknown;

    switch (type) {
      case 'HEARTBEAT':
        // 心跳响应 - 直接回复
        chrome.runtime.sendMessage(createResponse(id, 'HEARTBEAT' as any, {
          alive: true,
          timestamp: Date.now(),
          quickjsLoaded: quickjsModule !== null,
          babelLoaded: babelParser !== null,
        }));
        return;

      case 'QUICKJS_EXECUTE':
        result = await handleQuickJSExecute(payload);
        break;

      case 'BABEL_ANALYZE':
        result = await handleBabelAnalyze(payload);
        break;

      default:
        throw new Error(`Unknown task type: ${type}`);
    }

    // 发送成功结果
    chrome.runtime.sendMessage(createResponse(id, 'RESULT', result));
  } catch (err) {
    // 发送错误结果
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`[Offscreen] Task ${type} failed:`, errorMessage);
    chrome.runtime.sendMessage(createResponse(id, 'ERROR', errorMessage));
  }
}

// ─── 消息监听器注册 ───

chrome.runtime.onMessage.addListener(
  (message: unknown, _sender, _sendResponse) => {
    // 验证消息格式
    if (
      typeof message !== 'object' ||
      message === null ||
      !('__wt' in message) ||
      !(message as OffscreenMessage).__wt
    ) {
      return false;
    }

    const msg = message as OffscreenMessage;

    // 只处理发给offscreen的任务消息
    if (
      msg.type !== 'QUICKJS_EXECUTE' &&
      msg.type !== 'BABEL_ANALYZE' &&
      msg.type !== 'HEARTBEAT'
    ) {
      return false;
    }

    // 异步处理（不阻塞消息通道）
    handleMessage(msg);
    return false;
  }
);

// ─── 启动日志 ───
console.log('[WebTrace Offscreen] Document loaded and ready');
