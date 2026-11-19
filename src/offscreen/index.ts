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
 *
 * 使用 core/quickjs 的 executeCode()：它会注入 __vmTrace 回调并收集 traceEntries，
 * 并且返回 { success, value, error, traceEntries, executionTime }。
 * 返回结构与 trace-execution.ts 的期望对齐：
 *   { traceLog, executionResult, memoryUsed, executionTimeMs }
 */
async function handleQuickJSExecute(payload: any): Promise<unknown> {
  const { code, config, inputs } = payload as {
    code: string;
    config?: { memoryLimit?: number; maxExecutionTime?: number; traceEnabled?: boolean; maxTraceEntries?: number };
    inputs?: Record<string, unknown>;
  };

  const { executeCode } = await import('@core/quickjs/sandbox');

  let source = code;
  // 把 inputs 注入为全局变量，便于 VM 代码读取输入
  if (inputs && Object.keys(inputs).length > 0) {
    const assignments = Object.entries(inputs)
      .map(([k, v]) => `var ${k} = ${JSON.stringify(v)};`)
      .join('\n');
    source = `${assignments}\n${code}`;
  }

  const result = await executeCode(source, {
    memoryLimit: config?.memoryLimit,
    maxExecutionTime: config?.maxExecutionTime,
    traceEnabled: config?.traceEnabled !== false,
  });

  if (!result.success) {
    throw new Error(result.error || 'QuickJS execution failed');
  }

  const traceLog = result.traceEntries || [];
  const maxEntries = config?.maxTraceEntries || Infinity;
  const limited = traceLog.length > maxEntries ? traceLog.slice(0, maxEntries) : traceLog;

  return {
    traceLog: limited,
    executionResult: result.value ?? null,
    memoryUsed: 0,
    executionTimeMs: result.executionTime,
  };
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
 *
 * 返回任务结果（供 chrome.runtime.sendMessage 的 promise 直接拿到），
 * 同时继续广播 RESULT/ERROR 消息（供 OffscreenManager 的 pendingTasks 通道使用）。
 * 两条通道都必须保留：MCP 工具用 sendMessage 的返回值，内部 TRACE_DATA 用广播。
 */
async function handleMessage(message: OffscreenMessage): Promise<unknown> {
  const { id, type, payload } = message;

  try {
    let result: unknown;

    switch (type) {
      case 'HEARTBEAT': {
        // 心跳响应 - 直接回复
        const beat = {
          alive: true,
          timestamp: Date.now(),
          quickjsLoaded: quickjsModule !== null,
          babelLoaded: babelParser !== null,
        };
        chrome.runtime.sendMessage(createResponse(id, 'HEARTBEAT' as any, beat));
        return beat;
      }

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
    return result;
  } catch (err) {
    // 发送错误结果
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`[Offscreen] Task ${type} failed:`, errorMessage);
    chrome.runtime.sendMessage(createResponse(id, 'ERROR', errorMessage));
    throw err;
  }
}

// ─── 消息监听器注册 ───

chrome.runtime.onMessage.addListener(
  (message: unknown, _sender, sendResponse) => {
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

    // 异步处理，并通过 sendResponse 回给发起方。
    // 工具侧（trace-execution.ts）读取的是 { success, data|error } 形状的响应，
    // 因此这里必须显式回包；只广播 RESULT 会让 sendMessage() 解析成 undefined。
    handleMessage(msg)
      .then((result) => {
        sendResponse({ success: true, data: result });
      })
      .catch((err) => {
        sendResponse({
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      });

    return true; // 保持消息通道打开以支持异步 sendResponse
  }
);

// ─── 启动日志 ───
console.log('[WebTrace Offscreen] Document loaded and ready');
