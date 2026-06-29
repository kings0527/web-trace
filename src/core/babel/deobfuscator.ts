/**
 * Deobfuscator - 基础JS反混淆预处理
 *
 * 在AST分析前执行，将混淆代码还原到可识别程度，
 * 使VM Pattern Detector能够正确工作。
 *
 * 支持的反混淆变换：
 * 1. 字符串数组解密：识别形如 arr = ["xxx","yyy"] 的字符串数组，
 *    将 arr[0]、arr[1] 等引用替换为实际字符串值
 * 2. 常量折叠：计算纯常量表达式（如 1+2 → 3, "a"+"b" → "ab"）
 * 3. 死代码消除：移除 if(false){...} 等不可达代码
 * 4. 控制流反平坦化（简单版）：识别 "2|0|1".split("|") + switch 模式
 *
 * @module deobfuscator
 */

import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
import generate from '@babel/generator';
import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';

// ─── 类型定义 ───

/** 反混淆结果 */
export interface DeobfuscateResult {
  /** 反混淆后的代码 */
  code: string;
  /** 已应用的变换名称列表 */
  transformsApplied: string[];
  /** 整体置信度 (0-1)，越高表示越多变换被成功应用 */
  confidence: number;
}

/** 可用的变换类型 */
export type Transform =
  | 'stringArrayDecrypt'
  | 'constantFolding'
  | 'deadCodeElimination'
  | 'controlFlowUnflattening';

// ─── 变换实现 ───

/**
 * 字符串数组解密变换
 *
 * 查找被大量索引访问的字符串数组变量声明，
 * 将所有 arr[N] 形式的引用内联替换为实际字符串字面量。
 *
 * 匹配模式：
 * ```js
 * var _0xabc = ["hello", "world", "push", "log"];
 * // ... 代码中出现 _0xabc[0], _0xabc[1] 等
 * ```
 */
function applyStringArrayDecrypt(ast: t.File): number {
  let replacements = 0;

  // 第一遍：收集候选字符串数组
  const stringArrays = new Map<string, string[]>();

  traverse(ast, {
    VariableDeclarator(path) {
      const init = path.node.init;
      const id = path.node.id;

      if (!t.isIdentifier(id) || !t.isArrayExpression(init)) return;

      // 检查是否全部为字符串字面量（允许少量非字符串）
      const elements = init.elements;
      if (elements.length < 3) return; // 太短的不算

      const strings: string[] = [];
      let stringCount = 0;

      for (const elem of elements) {
        if (t.isStringLiteral(elem)) {
          strings.push(elem.value);
          stringCount++;
        } else {
          strings.push(''); // 非字符串占位
        }
      }

      // 至少80%是字符串
      if (stringCount / elements.length >= 0.8) {
        stringArrays.set(id.name, strings);
      }
    },
  });

  if (stringArrays.size === 0) return 0;

  // 第二遍：替换所有 arr[N] 引用
  traverse(ast, {
    MemberExpression(path) {
      if (!path.node.computed) return;

      const obj = path.node.object;
      const prop = path.node.property;

      if (!t.isIdentifier(obj)) return;
      if (!t.isNumericLiteral(prop)) return;

      const arrayName = obj.name;
      const index = prop.value;

      const arr = stringArrays.get(arrayName);
      if (!arr) return;

      if (index >= 0 && index < arr.length && arr[index] !== '') {
        path.replaceWith(t.stringLiteral(arr[index]));
        replacements++;
      }
    },
  });

  return replacements;
}

/**
 * 常量折叠变换
 *
 * 遍历BinaryExpression和UnaryExpression，
 * 如果操作数都是字面量则计算结果并替换。
 *
 * 支持：
 * - 数值计算: 1 + 2 → 3, 10 * 5 → 50
 * - 字符串拼接: "a" + "b" → "ab"
 * - 一元运算: -1, !true, ~0xFF
 * - typeof null → "object"
 */
function applyConstantFolding(ast: t.File): number {
  let folds = 0;

  traverse(ast, {
    // 二元表达式常量折叠
    BinaryExpression: {
      exit(path) {
        const { left, right, operator } = path.node;

        // 数值 op 数值
        if (t.isNumericLiteral(left) && t.isNumericLiteral(right)) {
          const result = evaluateNumericBinary(operator, left.value, right.value);
          if (result !== undefined) {
            if (typeof result === 'number') {
              path.replaceWith(t.numericLiteral(result));
            } else if (typeof result === 'boolean') {
              path.replaceWith(t.booleanLiteral(result));
            }
            folds++;
            return;
          }
        }

        // 字符串 + 字符串
        if (
          operator === '+' &&
          t.isStringLiteral(left) &&
          t.isStringLiteral(right)
        ) {
          path.replaceWith(t.stringLiteral(left.value + right.value));
          folds++;
          return;
        }

        // 字符串 + 数值 / 数值 + 字符串
        if (operator === '+') {
          if (t.isStringLiteral(left) && t.isNumericLiteral(right)) {
            path.replaceWith(t.stringLiteral(left.value + String(right.value)));
            folds++;
            return;
          }
          if (t.isNumericLiteral(left) && t.isStringLiteral(right)) {
            path.replaceWith(t.stringLiteral(String(left.value) + right.value));
            folds++;
            return;
          }
        }
      },
    },

    // 一元表达式常量折叠
    UnaryExpression: {
      exit(path) {
        const { operator, argument } = path.node;

        if (t.isNumericLiteral(argument)) {
          switch (operator) {
            case '-':
              path.replaceWith(t.numericLiteral(-argument.value));
              folds++;
              return;
            case '+':
              path.replaceWith(t.numericLiteral(+argument.value));
              folds++;
              return;
            case '~':
              path.replaceWith(t.numericLiteral(~argument.value));
              folds++;
              return;
            case '!':
              path.replaceWith(t.booleanLiteral(!argument.value));
              folds++;
              return;
            case 'void':
              path.replaceWith(t.identifier('undefined'));
              folds++;
              return;
          }
        }

        if (t.isBooleanLiteral(argument) && operator === '!') {
          path.replaceWith(t.booleanLiteral(!argument.value));
          folds++;
          return;
        }
      },
    },
  });

  return folds;
}

/**
 * 计算两个数值的二元运算结果
 */
function evaluateNumericBinary(
  operator: string,
  left: number,
  right: number
): number | boolean | undefined {
  switch (operator) {
    case '+': return left + right;
    case '-': return left - right;
    case '*': return left * right;
    case '/': return right !== 0 ? left / right : undefined;
    case '%': return right !== 0 ? left % right : undefined;
    case '**': return left ** right;
    case '|': return left | right;
    case '&': return left & right;
    case '^': return left ^ right;
    case '<<': return left << right;
    case '>>': return left >> right;
    case '>>>': return left >>> right;
    case '==': return left == right;
    case '===': return left === right;
    case '!=': return left != right;
    case '!==': return left !== right;
    case '<': return left < right;
    case '<=': return left <= right;
    case '>': return left > right;
    case '>=': return left >= right;
    default: return undefined;
  }
}

/**
 * 死代码消除变换
 *
 * 移除明确不可达的代码块：
 * - if(false) { ... } → 移除
 * - if(true) { A } else { B } → A
 * - if(0) { ... } → 移除
 * - 条件表达式: false ? a : b → b
 */
function applyDeadCodeElimination(ast: t.File): number {
  let eliminations = 0;

  traverse(ast, {
    IfStatement(path: NodePath<t.IfStatement>) {
      const test = path.node.test;
      const truthiness = evaluateTruthiness(test);

      if (truthiness === true) {
        // if(true) { A } else { B } → A
        if (t.isBlockStatement(path.node.consequent)) {
          path.replaceWithMultiple(path.node.consequent.body as t.Statement[]);
        } else {
          path.replaceWith(path.node.consequent);
        }
        eliminations++;
      } else if (truthiness === false) {
        // if(false) { A } else { B } → B (或删除)
        if (path.node.alternate) {
          if (t.isBlockStatement(path.node.alternate)) {
            path.replaceWithMultiple(path.node.alternate.body as t.Statement[]);
          } else {
            path.replaceWith(path.node.alternate);
          }
        } else {
          path.remove();
        }
        eliminations++;
      }
    },

    ConditionalExpression(path) {
      const truthiness = evaluateTruthiness(path.node.test);

      if (truthiness === true) {
        path.replaceWith(path.node.consequent);
        eliminations++;
      } else if (truthiness === false) {
        path.replaceWith(path.node.alternate);
        eliminations++;
      }
    },
  });

  return eliminations;
}

/**
 * 评估表达式的truthy/falsy值
 * 返回 true/false 如果能确定，否则返回 undefined
 */
function evaluateTruthiness(node: t.Expression | t.Node): boolean | undefined {
  if (t.isBooleanLiteral(node)) return node.value;
  if (t.isNumericLiteral(node)) return node.value !== 0;
  if (t.isStringLiteral(node)) return node.value.length > 0;
  if (t.isNullLiteral(node)) return false;
  if (t.isIdentifier(node) && node.name === 'undefined') return false;

  // !expr
  if (t.isUnaryExpression(node) && node.operator === '!') {
    const inner = evaluateTruthiness(node.argument);
    return inner !== undefined ? !inner : undefined;
  }

  return undefined;
}

/**
 * 控制流反平坦化（简单版）
 *
 * 识别 "2|0|1|3".split("|") + while + switch 模式，
 * 按照数组指定的顺序重组代码块。
 *
 * 匹配模式：
 * ```js
 * var order = "2|0|1|3".split("|");
 * var i = 0;
 * while(true) {
 *   switch(order[i++]) {
 *     case "0": block0(); break;
 *     case "1": block1(); break;
 *     case "2": block2(); break;
 *     case "3": block3(); break;
 *   }
 *   break;
 * }
 * ```
 * 还原为：block2(); block0(); block1(); block3();
 */
function applyControlFlowUnflattening(ast: t.File): number {
  let unflattenings = 0;

  traverse(ast, {
    WhileStatement(path: NodePath<t.WhileStatement>) {
      const body = path.node.body;
      if (!t.isBlockStatement(body)) return;

      // 查找body中的switch
      const switchStmt = body.body.find((s) => t.isSwitchStatement(s)) as t.SwitchStatement | undefined;
      if (!switchStmt) return;

      // 检查switch的discriminant是否为 order[i++] 或类似模式
      const disc = switchStmt.discriminant;
      if (!t.isMemberExpression(disc) || !disc.computed) return;

      const orderArrayName = t.isIdentifier(disc.object) ? disc.object.name : null;
      if (!orderArrayName) return;

      // 向上查找order数组的声明（"2|0|1".split("|")）
      const parentBlock = path.parentPath;
      if (!parentBlock || !('body' in parentBlock.node)) return;

      const siblings = (parentBlock.node as t.BlockStatement).body;
      let orderArray: string[] | null = null;

      for (const sibling of siblings) {
        if (!t.isVariableDeclaration(sibling)) continue;

        for (const decl of sibling.declarations) {
          if (!t.isIdentifier(decl.id) || decl.id.name !== orderArrayName) continue;
          if (!decl.init) continue;

          // 匹配 "2|0|1".split("|")
          if (
            t.isCallExpression(decl.init) &&
            t.isMemberExpression(decl.init.callee) &&
            t.isIdentifier(decl.init.callee.property) &&
            decl.init.callee.property.name === 'split' &&
            t.isStringLiteral(decl.init.callee.object) &&
            decl.init.arguments.length === 1 &&
            t.isStringLiteral(decl.init.arguments[0])
          ) {
            const str = decl.init.callee.object.value;
            const separator = decl.init.arguments[0].value;
            orderArray = str.split(separator);
          }
        }
      }

      if (!orderArray || orderArray.length === 0) return;

      // 按order重排switch cases
      const caseMap = new Map<string, t.Statement[]>();
      for (const caseClause of switchStmt.cases) {
        if (caseClause.test && t.isStringLiteral(caseClause.test)) {
          // 收集case体（去掉末尾的break）
          const stmts = caseClause.consequent.filter(
            (s) => !t.isBreakStatement(s)
          );
          caseMap.set(caseClause.test.value, stmts);
        }
      }

      // 按order数组顺序生成新语句序列
      const reorderedStmts: t.Statement[] = [];
      for (const key of orderArray) {
        const stmts = caseMap.get(key);
        if (stmts) {
          reorderedStmts.push(...stmts);
        }
      }

      if (reorderedStmts.length > 0) {
        path.replaceWithMultiple(reorderedStmts as t.Statement[]);
        unflattenings++;
      }
    },
  });

  return unflattenings;
}

// ─── 公共API ───

/**
 * 对指定代码应用选定的反混淆变换
 *
 * @param code - 混淆后的JavaScript源码
 * @param transforms - 要应用的变换列表
 * @returns 变换后的代码
 */
export function applyTransform(code: string, transforms: Transform[]): string {
  try {
    let ast = parse(code, {
      sourceType: 'unambiguous',
      plugins: ['dynamicImport', 'optionalChaining', 'nullishCoalescingOperator'],
      errorRecovery: true,
    });

    for (const transform of transforms) {
      switch (transform) {
        case 'stringArrayDecrypt':
          applyStringArrayDecrypt(ast);
          break;
        case 'constantFolding':
          applyConstantFolding(ast);
          break;
        case 'deadCodeElimination':
          applyDeadCodeElimination(ast);
          break;
        case 'controlFlowUnflattening':
          applyControlFlowUnflattening(ast);
          break;
      }
    }

    const output = generate(ast, { comments: true, compact: false });
    return output.code;
  } catch (err) {
    console.error('[Deobfuscator] Transform failed:', err);
    return code;
  }
}

/**
 * 执行完整的反混淆预处理流程
 *
 * 按照最优顺序依次应用所有可用变换：
 * 1. 字符串数组解密（先还原字符串，后续变换才能识别更多模式）
 * 2. 常量折叠（计算所有可折叠表达式）
 * 3. 死代码消除（移除不可达代码）
 * 4. 控制流反平坦化（重排代码块顺序）
 *
 * @param code - 混淆后的JavaScript源码
 * @returns 反混淆结果
 *
 * @example
 * ```ts
 * const obfuscatedCode = getObfuscatedVMCode();
 * const result = deobfuscate(obfuscatedCode);
 *
 * if (result.confidence > 0.3) {
 *   // 使用反混淆后的代码进行VM模式检测
 *   const dispatchers = detectVMDispatchers(result.code);
 * }
 * ```
 */
export function deobfuscate(code: string): DeobfuscateResult {
  const transformsApplied: string[] = [];
  let totalChanges = 0;

  try {
    const ast = parse(code, {
      sourceType: 'unambiguous',
      plugins: ['dynamicImport', 'optionalChaining', 'nullishCoalescingOperator'],
      errorRecovery: true,
    });

    // 1. 字符串数组解密
    const strDecryptCount = applyStringArrayDecrypt(ast);
    if (strDecryptCount > 0) {
      transformsApplied.push(`stringArrayDecrypt(${strDecryptCount})`);
      totalChanges += strDecryptCount;
    }

    // 2. 常量折叠（可能需要多轮迭代）
    let foldTotal = 0;
    for (let i = 0; i < 3; i++) {
      const folds = applyConstantFolding(ast);
      foldTotal += folds;
      if (folds === 0) break; // 没有更多可折叠项
    }
    if (foldTotal > 0) {
      transformsApplied.push(`constantFolding(${foldTotal})`);
      totalChanges += foldTotal;
    }

    // 3. 死代码消除
    const elimCount = applyDeadCodeElimination(ast);
    if (elimCount > 0) {
      transformsApplied.push(`deadCodeElimination(${elimCount})`);
      totalChanges += elimCount;
    }

    // 4. 控制流反平坦化
    const unflatCount = applyControlFlowUnflattening(ast);
    if (unflatCount > 0) {
      transformsApplied.push(`controlFlowUnflattening(${unflatCount})`);
      totalChanges += unflatCount;
    }

    // 生成最终代码
    const output = generate(ast, { comments: true, compact: false });

    // 计算置信度：基于总变换数的对数归一化
    const confidence = totalChanges > 0
      ? Math.min(1, Math.log10(totalChanges + 1) / 2)
      : 0;

    return {
      code: output.code,
      transformsApplied,
      confidence,
    };
  } catch (err) {
    console.error('[Deobfuscator] Deobfuscation failed:', err);
    return {
      code,
      transformsApplied: [],
      confidence: 0,
    };
  }
}
