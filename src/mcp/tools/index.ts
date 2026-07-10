/**
 * WebTrace MCP Tools - Barrel Export
 *
 * 统一导出所有 MCP Tool 的定义、Schema 和 Handler
 */

// detect_protection
export {
  detectProtectionInputSchema,
  detectProtectionMeta,
  handleDetectProtection,
  type DetectProtectionInput,
  type DetectProtectionOutput,
} from './detect-protection';

// analyze_jsvmp
export {
  analyzeJsvmpInputSchema,
  analyzeJsvmpMeta,
  handleAnalyzeJsvmp,
  type AnalyzeJsvmpInput,
  type AnalyzeJsvmpOutput,
} from './analyze-jsvmp';

// trace_execution
export {
  traceExecutionInputSchema,
  traceExecutionMeta,
  handleTraceExecution,
  type TraceExecutionInput,
  type TraceExecutionOutput,
} from './trace-execution';

// extract_bytecode
export {
  extractBytecodeInputSchema,
  extractBytecodeMeta,
  handleExtractBytecode,
  type ExtractBytecodeInput,
  type ExtractBytecodeOutput,
} from './extract-bytecode';

// hook_api
export {
  hookApiInputSchema,
  hookApiMeta,
  handleHookApi,
  type HookApiInput,
  type HookApiOutput,
  type HookLogEntry,
  getHookLogsStore,
  getActiveHookConfigs,
} from './hook-api';

// get_hook_logs
export {
  getHookLogsInputSchema,
  getHookLogsMeta,
  handleGetHookLogs,
  type GetHookLogsInput,
  type GetHookLogsOutput,
} from './get-hook-logs';

// page_state
export {
  pageStateInputSchema,
  pageStateMeta,
  handlePageState,
  type PageStateInput,
  type PageStateOutput,
} from './page-state';

// browser tab control
export {
  listTabsInputSchema,
  listTabsMeta,
  handleListTabs,
  activateTabInputSchema,
  activateTabMeta,
  handleActivateTab,
  navigateInputSchema,
  navigateMeta,
  handleNavigate,
  type ListTabsInput,
  type ListTabsOutput,
  type ActivateTabInput,
  type ActivateTabOutput,
  type NavigateInput,
  type NavigateOutput,
} from './browser-tabs';

// DOM inspection
export {
  domSnapshotInputSchema,
  domSnapshotMeta,
  handleDomSnapshot,
  queryDomInputSchema,
  queryDomMeta,
  handleQueryDom,
  type DomSnapshotInput,
  type DomSnapshotOutput,
  type QueryDomInput,
  type QueryDomOutput,
} from './dom-inspection';

// deobfuscate
export {
  deobfuscateInputSchema,
  deobfuscateMeta,
  handleDeobfuscate,
  type DeobfuscateInput,
  type DeobfuscateOutput,
} from './deobfuscate';

// extract_wasm
export {
  extractWasmInputSchema,
  extractWasmMeta,
  handleExtractWasm,
  type ExtractWasmInput,
  type ExtractWasmOutput,
} from './extract-wasm';

// analyze_wasm
export {
  analyzeWasmInputSchema,
  analyzeWasmMeta,
  handleAnalyzeWasm,
  type AnalyzeWasmInput,
  type AnalyzeWasmOutput,
} from './analyze-wasm';

// dump_wasm_memory
export {
  dumpWasmMemoryInputSchema,
  dumpWasmMemoryMeta,
  handleDumpWasmMemory,
  type DumpWasmMemoryInput,
  type DumpWasmMemoryOutput,
} from './dump-wasm-memory';
