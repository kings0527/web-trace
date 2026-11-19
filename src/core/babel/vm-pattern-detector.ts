/**
 * VM Pattern Detector - 自动识别JSVMP派发循环模式
 *
 * 支持3种常见VM派发模式：
 * 1. while-switch: while(true) { switch(bytecode[pc]) { case 0: ... } }
 * 2. while-if-else: while(true) { if(op===0){...} else if(op===1){...} }
 * 3. handler-table: handlers[opcode]() 或 table[op].call(vm)
 *
 * @module vm-pattern-detector
 */

import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
import * as t from '@babel/types';
import type { VMDispatcherInfo } from '@shared/types';

// ─── 类型定义 ───

// ─── 辅助函数 ───

/**
 * 判断表达式是否为无限循环条件
 * 支持: true, 1, !0, !false, !!1 等
 */
function isInfiniteLoopCondition(node: t.Node | null | undefined): boolean {
  if (!node) return false;

  // while(true)
  if (t.isBooleanLiteral(node) && node.value === true) return true;

  // while(1) / while(非零数字)
  if (t.isNumericLiteral(node) && node.value !== 0) return true;

  // while(!0) / while(!false) / while(!null)
  if (t.isUnaryExpression(node) && node.operator === '!') {
    const arg = node.argument;
    if (t.isNumericLiteral(arg) && arg.value === 0) return true;
    if (t.isBooleanLiteral(arg) && arg.value === false) return true;
    if (t.isNullLiteral(arg)) return true;
  }

  // while(!!1) 等双重否定
  if (
    t.isUnaryExpression(node) &&
    node.operator === '!' &&
    t.isUnaryExpression(node.argument) &&
    node.argument.operator === '!'
  ) {
    return true;
  }

  return false;
}

/**
 * 判断for语句是否为无限循环 (for(;;))
 * 即init/test/update均为空，或test为truthy
 */
function isInfiniteForLoop(node: t.ForStatement): boolean {
  // for(;;) 形式 —— test为null
  if (!node.test) return true;

  // for(;true;) 或 for(;1;) 等
  return isInfiniteLoopCondition(node.test);
}

// ─── 常量折叠（控制流平坦化 state machine 支持） ───

/** 折叠范围上限，避免病态表达式拖慢分析 */
const MAX_FOLD_DEPTH = 32;

/**
 * 对纯常量表达式做递归折叠，返回数值。
 *
 * obfuscator.io / javascript-obfuscator 的「控制流平坦化」会把 case 标签写成
 * 算术表达式而不是字面量，例如：
 *   case 48+7-50:  → 5
 *   case 99+16-69: → 46
 *   case 0x10|0x1: → 17
 *
 * 支持：+ - * / % << >> >>> & | ^、一元 - + ~ !、括号。
 * 无法静态求值（含标识符、函数调用等）时返回 undefined —— 调用方应降级为「仅保留标签」。
 */
function constFold(node: t.Node | null | undefined, depth = 0): number | undefined {
  if (!node || depth > MAX_FOLD_DEPTH) return undefined;

  if (t.isNumericLiteral(node)) return node.value;

  if (t.isParenthesizedExpression(node)) {
    return constFold(node.expression, depth + 1);
  }

  if (t.isUnaryExpression(node)) {
    const arg = constFold(node.argument, depth + 1);
    if (arg === undefined) return undefined;
    switch (node.operator) {
      case '-':
        return -arg;
      case '+':
        return +arg;
      case '~':
        return ~arg;
      case '!':
        return arg === 0 ? 1 : 0;
      default:
        return undefined;
    }
  }

  if (t.isBinaryExpression(node)) {
    const left = constFold(node.left, depth + 1);
    if (left === undefined) return undefined;
    const right = constFold(node.right, depth + 1);
    if (right === undefined) return undefined;

    switch (node.operator) {
      case '+':
        return left + right;
      case '-':
        return left - right;
      case '*':
        return left * right;
      case '/':
        return left / right;
      case '%':
        return left % right;
      case '<<':
        return left << right;
      case '>>':
        return left >> right;
      case '>>>':
        return left >>> right;
      case '&':
        return left & right;
      case '|':
        return left | right;
      case '^':
        return left ^ right;
      default:
        return undefined;
    }
  }

  return undefined;
}

/**
 * 检查一段语句中是否给某个标识符赋值（用于确认状态机的状态变量回写）。
 * 只做浅层 + 一层函数体内的扫描，控制成本。
 */
function bodyAssignsIdentifier(stmts: t.Statement[], name: string): boolean {
  let found = false;

  const visit = (node: t.Node | null | undefined) => {
    if (found || !node) return;
    if (t.isAssignmentExpression(node)) {
      if (t.isIdentifier(node.left) && node.left.name === name) {
        found = true;
        return;
      }
    } else if (t.isUpdateExpression(node)) {
      if (t.isIdentifier(node.argument) && node.argument.name === name) {
        found = true;
        return;
      }
    }
    // 不深入嵌套函数（状态变量通常是同一个函数作用域）
    if (
      t.isFunctionDeclaration(node) ||
      t.isFunctionExpression(node) ||
      t.isArrowFunctionExpression(node)
    ) {
      return;
    }
    for (const key of t.VISITOR_KEYS[node.type] ?? []) {
      const child = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(child)) {
        for (const c of child) if (c && typeof c === 'object') visit(c as t.Node);
      } else if (child && typeof child === 'object' && 'type' in (child as object)) {
        visit(child as t.Node);
      }
    }
  };

  for (const stmt of stmts) visit(stmt);
  return found;
}

/**
 * 识别「状态机式」派发循环（控制流平坦化）。
 *
 * 形态：
 *   function f() {
 *     var s = 5;
 *     while (s) {                     // ← 循环测试是普通标识符（非常量）
 *       switch (s) {                  // ← discriminant 是同一个标识符
 *         case 48+7-50: { ...; s = 6; break; }   // ← 标签是算术表达式
 *         case 60+17-71: { ...; s = 7; break; }
 *       }
 *     }
 *   }
 *
 * 返回匹配到的 switch 节点与状态变量名；不匹配时返回 null。
 * 该判定是独立的 predicate，不放松 isInfiniteLoopCondition，因此不改变既有行为。
 */
function matchStateMachineDispatch(
  test: t.Expression | null | undefined,
  body: t.BlockStatement,
): { switchNode: t.SwitchStatement; stateVar: string } | null {
  if (!test || !t.isIdentifier(test)) return null;
  const stateVar = test.name;

  for (const stmt of body.body) {
    if (!t.isSwitchStatement(stmt)) continue;
    if (!t.isIdentifier(stmt.discriminant)) continue;
    if (stmt.discriminant.name !== stateVar) continue;

    // 至少一个 case 体回写状态变量，才认定为状态机（排除普通 while(var) 循环）
    const branches = stmt.cases.flatMap((c) => c.consequent);
    if (!bodyAssignsIdentifier(branches, stateVar)) continue;

    return { switchNode: stmt, stateVar };
  }

  return null;
}

/**
 * 从MemberExpression中提取数组名（字节码数组）和索引变量（PC）
 * 例如: bytecode[pc] -> { arrayName: 'bytecode', indexName: 'pc' }
 */
function extractMemberAccess(node: t.Expression): {
  arrayName: string;
  indexName: string;
} | null {
  if (!t.isMemberExpression(node)) return null;

  // 要求 obj[index] 形式（computed）
  if (!node.computed) return null;

  let arrayName = '';
  let indexName = '';

  // 对象部分：取标识符名
  if (t.isIdentifier(node.object)) {
    arrayName = node.object.name;
  } else {
    return null;
  }

  // 索引部分：取标识符名
  if (t.isIdentifier(node.property)) {
    indexName = node.property.name;
  } else if (t.isUpdateExpression(node.property) && t.isIdentifier(node.property.argument)) {
    // bytecode[pc++] 形式
    indexName = node.property.argument.name;
  } else {
    return null;
  }

  return { arrayName, indexName };
}

/**
 * 从switch的discriminant中尝试提取字节码数组名和PC变量名
 * 支持模式:
 *  - switch(arr[pc])
 *  - switch(op) 其中op在之前被赋值为 arr[pc]
 */
function extractDispatcherInfo(
  discriminant: t.Expression
): { bytecodeArrayName: string; pcVariableName: string } {
  // 直接MemberExpression: switch(bytecode[pc])
  const directAccess = extractMemberAccess(discriminant);
  if (directAccess) {
    return {
      bytecodeArrayName: directAccess.arrayName,
      pcVariableName: directAccess.indexName,
    };
  }

  // switch(op) —— 变量名推断
  if (t.isIdentifier(discriminant)) {
    return {
      bytecodeArrayName: '<inferred>',
      pcVariableName: discriminant.name,
    };
  }

  // switch(op = bytecode[pc++]) —— 赋值表达式形式
  if (t.isAssignmentExpression(discriminant)) {
    const left = discriminant.left;
    const right = discriminant.right;
    const access = extractMemberAccess(right);
    if (access && t.isIdentifier(left)) {
      return {
        bytecodeArrayName: access.arrayName,
        pcVariableName: access.indexName,
      };
    }
  }

  return {
    bytecodeArrayName: '<unknown>',
    pcVariableName: '<unknown>',
  };
}

/**
 * 提取switch语句中所有case标签值
 */
function extractCases(switchNode: t.SwitchStatement): Map<number, string> {
  const cases = new Map<number, string>();

  for (const caseClause of switchNode.cases) {
    if (caseClause.test) {
      let value: number | undefined;
      let label = '';

      if (t.isNumericLiteral(caseClause.test)) {
        value = caseClause.test.value;
        label = `case_${value}`;
      } else if (t.isStringLiteral(caseClause.test)) {
        value = parseInt(caseClause.test.value, 10);
        if (!isNaN(value)) {
          label = `case_${caseClause.test.value}`;
        }
      } else if (t.isIdentifier(caseClause.test)) {
        // case OPCODE_NAME: 形式（enum引用）
        label = caseClause.test.name;
      } else {
        // case 48+7-50: 形式（控制流平坦化，标签是常量算术表达式）
        value = constFold(caseClause.test);
        if (value !== undefined) {
          label = `case_${value}`;
        }
      }

      if (value !== undefined && !isNaN(value)) {
        cases.set(value, label);
      }
    }
  }

  return cases;
}

/**
 * 从if-else链中提取opcode值
 * 支持: if(op===0) / if(op==0) / if(op===0x10) 等
 */
function extractIfElseOpcodes(
  node: t.IfStatement,
  pcVarName: string
): Map<number, string> {
  const cases = new Map<number, string>();
  let current: t.Statement | null | undefined = node;
  let index = 0;

  while (current && t.isIfStatement(current)) {
    const test = current.test;

    // 匹配 op === N 或 op == N
    if (t.isBinaryExpression(test) && (test.operator === '===' || test.operator === '==')) {
      let identName = '';
      let numValue: number | undefined;

      if (t.isIdentifier(test.left) && t.isNumericLiteral(test.right)) {
        identName = test.left.name;
        numValue = test.right.value;
      } else if (t.isNumericLiteral(test.left) && t.isIdentifier(test.right)) {
        identName = test.right.name;
        numValue = test.left.value;
      }

      if (numValue !== undefined) {
        if (!pcVarName || identName === pcVarName) {
          cases.set(numValue, `branch_${index}`);
          if (!pcVarName) pcVarName = identName;
        }
      }
    }

    current = current.alternate;
    index++;
  }

  return cases;
}

/**
 * 检测handler-table模式
 * 匹配: handlers[opcode]() 或 table[op].call(vm) 等
 */
function detectHandlerTableInBody(body: t.Statement[]): {
  detected: boolean;
  tableName: string;
  indexName: string;
} {
  for (const stmt of body) {
    // handlers[opcode]() 形式
    if (t.isExpressionStatement(stmt) && t.isCallExpression(stmt.expression)) {
      const callee = stmt.expression.callee;

      // handlers[op]()
      if (t.isMemberExpression(callee) && callee.computed) {
        if (t.isIdentifier(callee.object) && t.isIdentifier(callee.property)) {
          return {
            detected: true,
            tableName: callee.object.name,
            indexName: callee.property.name,
          };
        }
      }

      // handlers[op].call(vm) 形式
      if (
        t.isMemberExpression(callee) &&
        !callee.computed &&
        t.isIdentifier(callee.property) &&
        callee.property.name === 'call'
      ) {
        const obj = callee.object;
        if (t.isMemberExpression(obj) && obj.computed) {
          if (t.isIdentifier(obj.object) && t.isIdentifier(obj.property)) {
            return {
              detected: true,
              tableName: obj.object.name,
              indexName: obj.property.name,
            };
          }
        }
      }
    }
  }

  return { detected: false, tableName: '', indexName: '' };
}

// ─── 主检测逻辑 ───

/**
 * 在已解析的AST中检测VM派发循环模式
 *
 * @param ast - 由@babel/parser解析的AST
 * @returns 检测到的所有VM派发器信息数组
 */
export function detectInCode(ast: t.File): VMDispatcherInfo[] {
  const dispatchers: VMDispatcherInfo[] = [];

  try {
    traverse(ast as t.Node, {
      /**
       * 检测while循环中的switch和if-else派发模式
       */
      WhileStatement(path) {
        const node = path.node;

        const body = node.body;
        if (!t.isBlockStatement(body)) return;

        // ─── 模式0: while-switch-state-machine（控制流平坦化） ───
        // 必须在无限循环判定之前处理：这类循环的 test 是普通状态变量（while(s)），
        // 不是真理值常量，因此 isInfiniteLoopCondition 必然为 false。
        if (!isInfiniteLoopCondition(node.test)) {
          const matched = matchStateMachineDispatch(node.test, body);
          if (matched) {
            const cases = extractCases(matched.switchNode);
            dispatchers.push({
              type: 'while-switch-state-machine',
              location: {
                line: node.loc?.start.line ?? 0,
                column: node.loc?.start.column ?? 0,
              },
              bytecodeArrayName: '<state-machine>',
              pcVariableName: matched.stateVar,
              opcodeCount: cases.size || matched.switchNode.cases.length,
              cases,
            });
          }
          return;
        }

        const stmts = body.body;
        if (stmts.length === 0) return;

        // ─── 模式1: while-switch ───
        for (const stmt of stmts) {
          if (t.isSwitchStatement(stmt)) {
            const info = extractDispatcherInfo(stmt.discriminant);
            const cases = extractCases(stmt);

            dispatchers.push({
              type: 'while-switch',
              location: {
                line: node.loc?.start.line ?? 0,
                column: node.loc?.start.column ?? 0,
              },
              bytecodeArrayName: info.bytecodeArrayName,
              pcVariableName: info.pcVariableName,
              opcodeCount: cases.size || stmt.cases.length,
              cases,
            });
            return;
          }
        }

        // ─── 模式2: while-if-else ───
        // 查找较长的if-else链（至少3个分支）
        for (const stmt of stmts) {
          if (t.isIfStatement(stmt)) {
            const cases = extractIfElseOpcodes(stmt, '');
            if (cases.size >= 3) {
              // 从第一个比较中推断PC变量名
              let pcVar = '<unknown>';
              const test = stmt.test;
              if (t.isBinaryExpression(test)) {
                if (t.isIdentifier(test.left)) pcVar = test.left.name;
                else if (t.isIdentifier(test.right)) pcVar = test.right.name;
              }

              dispatchers.push({
                type: 'while-if-else',
                location: {
                  line: node.loc?.start.line ?? 0,
                  column: node.loc?.start.column ?? 0,
                },
                bytecodeArrayName: '<inferred>',
                pcVariableName: pcVar,
                opcodeCount: cases.size,
                cases,
              });
              return;
            }
          }
        }

        // ─── 模式3: handler-table ───
        const tableResult = detectHandlerTableInBody(stmts);
        if (tableResult.detected) {
          dispatchers.push({
            type: 'handler-table',
            location: {
              line: node.loc?.start.line ?? 0,
              column: node.loc?.start.column ?? 0,
            },
            bytecodeArrayName: tableResult.tableName,
            pcVariableName: tableResult.indexName,
            opcodeCount: 0,
            cases: new Map(),
          });
        }
      },

      /**
       * 检测for(;;)循环中的派发模式
       */
      ForStatement(path) {
        const node = path.node;

        // 检查是否为无限循环
        if (!isInfiniteForLoop(node)) return;

        const body = node.body;
        if (!t.isBlockStatement(body)) return;

        const stmts = body.body;
        if (stmts.length === 0) return;

        // for(;;) { switch(...) { ... } }
        for (const stmt of stmts) {
          if (t.isSwitchStatement(stmt)) {
            const info = extractDispatcherInfo(stmt.discriminant);
            const cases = extractCases(stmt);

            dispatchers.push({
              type: 'while-switch', // for(;;) 等价于 while(true)
              location: {
                line: node.loc?.start.line ?? 0,
                column: node.loc?.start.column ?? 0,
              },
              bytecodeArrayName: info.bytecodeArrayName,
              pcVariableName: info.pcVariableName,
              opcodeCount: cases.size || stmt.cases.length,
              cases,
            });
            return;
          }
        }

        // for(;;) + if-else
        for (const stmt of stmts) {
          if (t.isIfStatement(stmt)) {
            const cases = extractIfElseOpcodes(stmt, '');
            if (cases.size >= 3) {
              let pcVar = '<unknown>';
              const test = stmt.test;
              if (t.isBinaryExpression(test)) {
                if (t.isIdentifier(test.left)) pcVar = test.left.name;
                else if (t.isIdentifier(test.right)) pcVar = test.right.name;
              }

              dispatchers.push({
                type: 'while-if-else',
                location: {
                  line: node.loc?.start.line ?? 0,
                  column: node.loc?.start.column ?? 0,
                },
                bytecodeArrayName: '<inferred>',
                pcVariableName: pcVar,
                opcodeCount: cases.size,
                cases,
              });
              return;
            }
          }
        }

        // for(;;) + handler-table
        const tableResult = detectHandlerTableInBody(stmts);
        if (tableResult.detected) {
          dispatchers.push({
            type: 'handler-table',
            location: {
              line: node.loc?.start.line ?? 0,
              column: node.loc?.start.column ?? 0,
            },
            bytecodeArrayName: tableResult.tableName,
            pcVariableName: tableResult.indexName,
            opcodeCount: 0,
            cases: new Map(),
          });
        }
      },
    });
  } catch (err) {
    console.error('[VMPatternDetector] AST traversal error:', err);
  }

  return dispatchers;
}

/**
 * 检测代码中的VM派发循环模式（从源码字符串开始）
 *
 * @param code - JavaScript源码字符串
 * @returns 检测到的所有VM派发器信息数组
 *
 * @example
 * ```ts
 * const code = `
 *   while(true) {
 *     switch(bytecode[pc++]) {
 *       case 0: stack.push(constants[bytecode[pc++]]); break;
 *       case 1: stack.push(stack.pop() + stack.pop()); break;
 *     }
 *   }
 * `;
 * const dispatchers = detectVMDispatchers(code);
 * // => [{ type: 'while-switch', bytecodeArrayName: 'bytecode', pcVariableName: 'pc', ... }]
 * ```
 */
export function detectVMDispatchers(code: string): VMDispatcherInfo[] {
  try {
    const ast = parse(code, {
      sourceType: 'unambiguous',
      plugins: ['dynamicImport', 'optionalChaining', 'nullishCoalescingOperator'],
      errorRecovery: true,
    });

    return detectInCode(ast);
  } catch (err) {
    console.error('[VMPatternDetector] Parse error:', err);
    return [];
  }
}
