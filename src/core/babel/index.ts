/**
 * WebTrace Babel AST Engine - Barrel Export
 *
 * 统一导出VM模式检测、插桩和反混淆模块
 *
 * @module core/babel
 */

// VM派发循环模式识别器
export { detectVMDispatchers, detectInCode } from './vm-pattern-detector';

// 自动插桩代码生成器
export {
  instrument,
  instrumentAST,
  generateTraceSetupCode,
  type InstrumentResult,
  type InstrumentOptions,
} from './instrumentor';

// 基础反混淆预处理器
export {
  deobfuscate,
  applyTransform,
  type DeobfuscateResult,
  type Transform,
} from './deobfuscator';
