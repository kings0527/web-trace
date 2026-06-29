/**
 * WebTrace WASM 模块 - Barrel Export
 */

export {
  validateWasmBinary,
  parseSections,
  parseModule,
  decodeFunctionBody,
  detectCryptoConstants,
  extractModuleMetadata,
} from './wasm-parser';
