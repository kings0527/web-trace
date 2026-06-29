/**
 * Instrumentor - 在VM派发循环中自动插入trace代码
 *
 * 在每个case/handler入口插入轻量trace调用，
 * 收集(PC, opcode, stackSnapshot)三元组用于后续分析。
 *
 * 插入的trace代码格式：
 * ```js
 * window.__wtTrace && window.__wtTrace(pc, opcode, typeof stack !== 'undefined' ? stack.slice() : []);
 * ```
 *
 * @module instrumentor
 */

import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
import generate from '@babel/generator';
import * as t from '@babel/types';
import type { NodePath } from '@babel/traverse';
import type { VMDispatcherInfo } from '@shared/types';

// ─── 类型定义 ───

/** 插桩结果 */
export interface InstrumentResult {
  /** 插桩后的完整代码 */
  instrumentedCode: string;
  /** 注入的trace点数量 */
  injectionPoints: number;
  /** trace收集器setup代码（需要在目标页面先执行） */
  traceSetupCode: string;
}

/** 插桩选项 */
export interface InstrumentOptions {
  /** 只插桩指定opcode范围 [min, max] */
  opcodeRange?: [number, number];
  /** 自定义trace函数名，默认 '__wtTrace' */
  traceFunctionName?: string;
  /** 是否捕获栈快照，默认true */
  captureStack?: boolean;
  /** 栈变量名推断（如果不指定则用通用探测） */
  stackVariableName?: string;
}

// ─── 辅助函数 ───

/**
 * 构建trace调用AST节点
 *
 * 生成形如：
 * window.__wtTrace && window.__wtTrace(pcExpr, opcodeExpr, stackExpr)
 */
function buildTraceCallExpression(
  pcExpr: t.Expression,
  opcodeExpr: t.Expression,
  options: InstrumentOptions
): t.ExpressionStatement {
  const fnName = options.traceFunctionName || '__wtTrace';
  const captureStack = options.captureStack !== false;

  // window.__wtTrace
  const traceFn = t.memberExpression(
    t.identifier('window'),
    t.identifier(fnName)
  );

  // 栈快照表达式
  let stackExpr: t.Expression;
  if (captureStack) {
    const stackVar = options.stackVariableName || 'stack';
    // typeof stack !== 'undefined' ? stack.slice() : []
    stackExpr = t.conditionalExpression(
      t.binaryExpression(
        '!==',
        t.unaryExpression('typeof', t.identifier(stackVar)),
        t.stringLiteral('undefined')
      ),
      t.callExpression(
        t.memberExpression(t.identifier(stackVar), t.identifier('slice')),
        []
      ),
      t.arrayExpression([])
    );
  } else {
    stackExpr = t.arrayExpression([]);
  }

  // window.__wtTrace(pc, opcode, stackSnapshot)
  const traceCall = t.callExpression(traceFn, [pcExpr, opcodeExpr, stackExpr]);

  // window.__wtTrace && window.__wtTrace(...)
  const logicalExpr = t.logicalExpression('&&', traceFn, traceCall);

  return t.expressionStatement(logicalExpr);
}

/**
 * 判断opcode值是否在允许范围内
 */
function isOpcodeInRange(
  opcodeValue: number | undefined,
  range?: [number, number]
): boolean {
  if (!range) return true;
  if (opcodeValue === undefined) return true; // 无法确定值时默认允许
  return opcodeValue >= range[0] && opcodeValue <= range[1];
}

/**
 * 从case的test节点中提取opcode数值
 */
function getCaseOpcodeValue(testNode: t.Expression | null): number | undefined {
  if (!testNode) return undefined; // default case
  if (t.isNumericLiteral(testNode)) return testNode.value;
  if (t.isStringLiteral(testNode)) {
    const parsed = parseInt(testNode.value, 10);
    return isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

// ─── 主实现 ───

/**
 * 对已解析的AST进行插桩（原地修改AST）
 *
 * @param ast - 由@babel/parser解析的AST
 * @param dispatchers - 由vm-pattern-detector检测到的派发器信息
 * @param options - 插桩选项
 * @returns 注入的trace点数量
 */
export function instrumentAST(
  ast: t.File,
  dispatchers: VMDispatcherInfo[],
  options: InstrumentOptions = {}
): number {
  let injectionCount = 0;

  if (dispatchers.length === 0) return 0;

  try {
    traverse(ast, {
      /**
       * 处理while循环中的switch派发
       */
      SwitchStatement(path: NodePath<t.SwitchStatement>) {
        // 查找匹配的dispatcher
        const parentWhile = path.findParent(
          (p: NodePath) => p.isWhileStatement() || p.isForStatement()
        );
        if (!parentWhile) return;

        const whileLoc = parentWhile.node.loc?.start;
        const matchingDispatcher = dispatchers.find(
          (d) =>
            (d.type === 'while-switch') &&
            d.location.line === (whileLoc?.line ?? -1)
        );

        if (!matchingDispatcher) return;

        const switchNode = path.node;
        const pcVarName = matchingDispatcher.pcVariableName;

        // 为每个case插入trace
        for (const caseClause of switchNode.cases) {
          const opcodeValue = getCaseOpcodeValue(caseClause.test ?? null);

          // 检查opcode范围过滤
          if (!isOpcodeInRange(opcodeValue, options.opcodeRange)) continue;

          // 构建trace调用
          const pcExpr: t.Expression =
            pcVarName !== '<unknown>' && pcVarName !== '<inferred>'
              ? t.identifier(pcVarName)
              : t.numericLiteral(-1);

          const opcodeExpr: t.Expression =
            opcodeValue !== undefined
              ? t.numericLiteral(opcodeValue)
              : (caseClause.test ? (caseClause.test as t.Expression) : t.numericLiteral(-1));

          const traceStmt = buildTraceCallExpression(pcExpr, opcodeExpr, options);

          // 在case体的最前面插入
          caseClause.consequent.unshift(traceStmt);
          injectionCount++;
        }
      },

      /**
       * 处理if-else链派发
       */
      IfStatement(path: NodePath<t.IfStatement>) {
        // 只处理在while/for中的顶级if（非嵌套alternate）
        const parentWhile = path.findParent(
          (p: NodePath) => p.isWhileStatement() || p.isForStatement()
        );
        if (!parentWhile) return;

        // 避免重复处理（只处理链的头部）
        if (path.parentPath && path.parentPath.isIfStatement()) return;

        const whileLoc = parentWhile.node.loc?.start;
        const matchingDispatcher = dispatchers.find(
          (d) =>
            d.type === 'while-if-else' &&
            d.location.line === (whileLoc?.line ?? -1)
        );

        if (!matchingDispatcher) return;

        const pcVarName = matchingDispatcher.pcVariableName;

        // 遍历if-else链
        let current: t.Statement | null | undefined = path.node;
        while (current && t.isIfStatement(current)) {
          const test = current.test;
          let opcodeValue: number | undefined;

          // 提取比较中的数值
          if (t.isBinaryExpression(test)) {
            if (t.isNumericLiteral(test.right)) {
              opcodeValue = test.right.value;
            } else if (t.isNumericLiteral(test.left)) {
              opcodeValue = test.left.value;
            }
          }

          if (!isOpcodeInRange(opcodeValue, options.opcodeRange)) {
            current = current.alternate;
            continue;
          }

          // 在consequent块开头插入trace
          const pcExpr: t.Expression =
            pcVarName !== '<unknown>' ? t.identifier(pcVarName) : t.numericLiteral(-1);
          const opcodeExpr: t.Expression =
            opcodeValue !== undefined
              ? t.numericLiteral(opcodeValue)
              : t.numericLiteral(-1);

          const traceStmt = buildTraceCallExpression(pcExpr, opcodeExpr, options);

          if (t.isBlockStatement(current.consequent)) {
            current.consequent.body.unshift(traceStmt);
          } else {
            // 单语句分支 -> 包装为block
            current.consequent = t.blockStatement([traceStmt, current.consequent]);
          }
          injectionCount++;

          current = current.alternate;
        }
      },
    });
  } catch (err) {
    console.error('[Instrumentor] AST instrumentation error:', err);
  }

  return injectionCount;
}

/**
 * 生成trace收集器setup代码
 * 此代码需要在目标页面的VM代码执行前注入
 *
 * @param options - 插桩选项
 * @returns setup代码字符串
 *
 * @example
 * ```js
 * // 注入后，window.__wtTrace 会收集所有trace数据
 * // 通过 window.__wtTraceData 访问收集到的数据
 * ```
 */
export function generateTraceSetupCode(options: InstrumentOptions = {}): string {
  const fnName = options.traceFunctionName || '__wtTrace';

  return `
(function() {
  if (window.${fnName}) return;

  var __traceBuffer = [];
  var __traceMaxSize = 100000;
  var __traceStartTime = Date.now();

  window.${fnName} = function(pc, opcode, stackSnapshot) {
    if (__traceBuffer.length >= __traceMaxSize) return;
    __traceBuffer.push({
      pc: pc,
      opcode: opcode,
      stackSnapshot: stackSnapshot,
      timestamp: Date.now() - __traceStartTime
    });
  };

  window.${fnName}Data = function() {
    return __traceBuffer;
  };

  window.${fnName}Clear = function() {
    __traceBuffer = [];
    __traceStartTime = Date.now();
  };

  window.${fnName}Export = function() {
    return JSON.stringify(__traceBuffer);
  };
})();
`.trim();
}

/**
 * 对JavaScript源码执行完整的插桩流程
 *
 * @param code - 原始JavaScript源码
 * @param dispatchers - 由vm-pattern-detector检测到的VM派发器信息
 * @param options - 插桩选项
 * @returns 插桩结果，包含插桩后代码、注入点数量、setup代码
 *
 * @example
 * ```ts
 * import { detectVMDispatchers } from './vm-pattern-detector';
 * import { instrument } from './instrumentor';
 *
 * const code = getVMCode();
 * const dispatchers = detectVMDispatchers(code);
 * const result = instrument(code, dispatchers);
 *
 * // 先注入setup代码
 * eval(result.traceSetupCode);
 * // 再执行插桩后的VM代码
 * eval(result.instrumentedCode);
 * // 收集trace数据
 * const traces = window.__wtTraceData();
 * ```
 */
export function instrument(
  code: string,
  dispatchers: VMDispatcherInfo[],
  options: InstrumentOptions = {}
): InstrumentResult {
  try {
    const ast = parse(code, {
      sourceType: 'unambiguous',
      plugins: ['dynamicImport', 'optionalChaining', 'nullishCoalescingOperator'],
      errorRecovery: true,
    });

    const injectionPoints = instrumentAST(ast, dispatchers, options);

    // 生成插桩后代码
    const output = generate(ast, {
      comments: true,
      compact: false,
    });

    return {
      instrumentedCode: output.code,
      injectionPoints,
      traceSetupCode: generateTraceSetupCode(options),
    };
  } catch (err) {
    console.error('[Instrumentor] Instrumentation failed:', err);
    return {
      instrumentedCode: code, // 失败时返回原始代码
      injectionPoints: 0,
      traceSetupCode: generateTraceSetupCode(options),
    };
  }
}
