/**
 * QuickJS WASM Sandbox Engine - Barrel Export
 */

// Sandbox core
export {
  getQuickJS,
  createContext,
  releaseContext,
  executeCode,
  dispose,
  type QuickJSWASMModule,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSRuntime,
  type QuickJSEvalResult,
  type ExecutionResult,
} from './sandbox';

// JSVMP Executor
export {
  JSVMPExecutor,
  type ExecutorOptions,
  type TraceResult,
  type OpcodeAnalysis,
  type OpcodeSemanticEntry,
  type CallSiteInfo,
} from './jsvmp-executor';

// Trace Collector
export {
  TraceCollector,
  type TraceFilter,
  type CollectorStats,
} from './trace-collector';
