/**
 * WebTrace WASM Binary Format Parser
 *
 * 解析 WASM 模块的 section 结构，提取模块元数据。
 *
 * WASM 格式：
 * magic: 0x00 0x61 0x73 0x6D (\0asm)
 * version: 0x01 0x00 0x00 0x00
 * sections: [id, size, content]...
 *
 * Section IDs:
 * 0=Custom, 1=Type, 2=Import, 3=Function, 4=Table, 5=Memory,
 * 6=Global, 7=Export, 8=Start, 9=Element, 10=Code, 11=Data
 */

import type {
  WasmSection,
  WasmValType,
  WasmImportEntry,
  WasmExportEntry,
  WasmFunctionInfo,
  WasmInstruction,
  ParsedWasmModule,
  CryptoSignature,
} from '@shared/types';

// ─── Constants ───

const WASM_MAGIC = new Uint8Array([0x00, 0x61, 0x73, 0x6d]);
const WASM_VERSION = new Uint8Array([0x01, 0x00, 0x00, 0x00]);

const SECTION_NAMES: Record<number, string> = {
  0: 'Custom',
  1: 'Type',
  2: 'Import',
  3: 'Function',
  4: 'Table',
  5: 'Memory',
  6: 'Global',
  7: 'Export',
  8: 'Start',
  9: 'Element',
  10: 'Code',
  11: 'Data',
  12: 'DataCount',
};

const VALTYPE_MAP: Record<number, WasmValType> = {
  0x7f: 'i32',
  0x7e: 'i64',
  0x7d: 'f32',
  0x7c: 'f64',
  0x7b: 'v128',
  0x70: 'funcref',
  0x6f: 'externref',
};

const EXPORT_KIND: Record<number, 'function' | 'table' | 'memory' | 'global'> = {
  0x00: 'function',
  0x01: 'table',
  0x02: 'memory',
  0x03: 'global',
};

const IMPORT_KIND = EXPORT_KIND;

// ─── Crypto Constants for Detection ───

/** AES S-Box (first 16 bytes for fast scan) */
const AES_SBOX_PREFIX = [0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76];

/** SHA-256 Initial Hash Values (H0-H7 as 32-bit big-endian) */
const SHA256_IV = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

/** SHA-256 Round Constants K[0..7] */
const SHA256_K_PREFIX = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5];

/** ChaCha20 sigma constant "expand 32-byte k" */
const CHACHA_SIGMA = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574];

/** SM3 IV */
const SM3_IV = [0x7380166f, 0x4914b2b9, 0x172442d7, 0xda8a0600, 0xa96f30bc, 0x163138aa, 0xe38dee4d, 0xb0fb0e4e];

/** SM4 S-Box prefix (FK constants) */
const SM4_FK = [0xa3b1bac6, 0x56aa3350, 0x677d9197, 0xb27022dc];

/** MD5 T table prefix (first 4 elements) */
const MD5_T_PREFIX = [0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee];

// ─── Reader Utility ───

class BinaryReader {
  private view: DataView;
  private bytes: Uint8Array;
  public offset: number;

  constructor(buffer: Uint8Array, startOffset = 0) {
    this.bytes = buffer;
    this.view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    this.offset = startOffset;
  }

  get remaining(): number {
    return this.bytes.length - this.offset;
  }

  readByte(): number {
    if (this.offset >= this.bytes.length) {
      throw new Error(`[WasmParser] Unexpected end of data at offset ${this.offset}`);
    }
    return this.bytes[this.offset++];
  }

  readBytes(n: number): Uint8Array {
    if (this.offset + n > this.bytes.length) {
      throw new Error(`[WasmParser] Cannot read ${n} bytes at offset ${this.offset}, remaining: ${this.remaining}`);
    }
    const slice = this.bytes.slice(this.offset, this.offset + n);
    this.offset += n;
    return slice;
  }

  /** LEB128 unsigned integer */
  readU32Leb128(): number {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = this.readByte();
      result |= (byte & 0x7f) << shift;
      shift += 7;
      if (shift > 35) {
        throw new Error('[WasmParser] LEB128 overflow');
      }
    } while (byte & 0x80);
    return result >>> 0;
  }

  /** LEB128 signed integer (i32) */
  readI32Leb128(): number {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = this.readByte();
      result |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);
    if (shift < 32 && (byte & 0x40)) {
      result |= -(1 << shift);
    }
    return result;
  }

  /** LEB128 signed integer (i64) as bigint */
  readI64Leb128(): bigint {
    let result = 0n;
    let shift = 0n;
    let byte: number;
    do {
      byte = this.readByte();
      result |= BigInt(byte & 0x7f) << shift;
      shift += 7n;
    } while (byte & 0x80);
    if (shift < 64n && (byte & 0x40)) {
      result |= -(1n << shift);
    }
    return result;
  }

  readF32(): number {
    const val = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return val;
  }

  readF64(): number {
    const val = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return val;
  }

  readU32LE(): number {
    const val = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return val;
  }

  readName(): string {
    const len = this.readU32Leb128();
    const bytes = this.readBytes(len);
    return new TextDecoder().decode(bytes);
  }

  skip(n: number): void {
    this.offset += n;
  }

  peek(): number {
    return this.bytes[this.offset];
  }
}

// ─── Parser Functions ───

/**
 * 验证 WASM 二进制的 magic number 和版本
 */
export function validateWasmBinary(binary: Uint8Array): boolean {
  if (binary.length < 8) return false;
  for (let i = 0; i < 4; i++) {
    if (binary[i] !== WASM_MAGIC[i]) return false;
  }
  for (let i = 0; i < 4; i++) {
    if (binary[i + 4] !== WASM_VERSION[i]) return false;
  }
  return true;
}

/**
 * 解析 WASM 模块所有 section
 */
export function parseSections(binary: Uint8Array): WasmSection[] {
  const reader = new BinaryReader(binary, 8); // skip magic + version
  const sections: WasmSection[] = [];

  while (reader.remaining > 0) {
    const sectionOffset = reader.offset;
    const id = reader.readByte();
    const size = reader.readU32Leb128();
    const dataOffset = reader.offset;

    if (reader.remaining < size) {
      // Truncated section, skip
      break;
    }

    const data = reader.readBytes(size);

    sections.push({
      id,
      name: SECTION_NAMES[id] || `Unknown(${id})`,
      offset: sectionOffset,
      size,
      data,
    });
  }

  return sections;
}

/**
 * 解析 Type section (id=1)
 */
function parseTypeSection(data: Uint8Array): { params: WasmValType[]; results: WasmValType[] }[] {
  const reader = new BinaryReader(data);
  const count = reader.readU32Leb128();
  const types: { params: WasmValType[]; results: WasmValType[] }[] = [];

  for (let i = 0; i < count; i++) {
    const form = reader.readByte(); // 0x60 = functype
    if (form !== 0x60) {
      // Skip unknown type form
      break;
    }

    const paramCount = reader.readU32Leb128();
    const params: WasmValType[] = [];
    for (let p = 0; p < paramCount; p++) {
      const vt = reader.readByte();
      params.push(VALTYPE_MAP[vt] || 'i32');
    }

    const resultCount = reader.readU32Leb128();
    const results: WasmValType[] = [];
    for (let r = 0; r < resultCount; r++) {
      const vt = reader.readByte();
      results.push(VALTYPE_MAP[vt] || 'i32');
    }

    types.push({ params, results });
  }

  return types;
}

/**
 * 解析 Import section (id=2)
 */
function parseImportSection(data: Uint8Array): WasmImportEntry[] {
  const reader = new BinaryReader(data);
  const count = reader.readU32Leb128();
  const imports: WasmImportEntry[] = [];

  for (let i = 0; i < count; i++) {
    const module = reader.readName();
    const name = reader.readName();
    const kindByte = reader.readByte();
    const kind = IMPORT_KIND[kindByte] || 'function';

    let typeIndex: number | undefined;

    switch (kindByte) {
      case 0x00: // function
        typeIndex = reader.readU32Leb128();
        break;
      case 0x01: // table
        reader.readByte(); // elemtype
        reader.readU32Leb128(); // limits flags
        reader.readU32Leb128(); // limits min
        if (reader.peek() !== undefined) {
          // Check if there's a max
        }
        break;
      case 0x02: // memory
        {
          const flags = reader.readU32Leb128();
          reader.readU32Leb128(); // min
          if (flags & 1) reader.readU32Leb128(); // max
        }
        break;
      case 0x03: // global
        reader.readByte(); // valtype
        reader.readByte(); // mutability
        break;
    }

    imports.push({ module, name, kind, typeIndex });
  }

  return imports;
}

/**
 * 解析 Function section (id=3) - 只包含 type indices
 */
function parseFunctionSection(data: Uint8Array): number[] {
  const reader = new BinaryReader(data);
  const count = reader.readU32Leb128();
  const typeIndices: number[] = [];

  for (let i = 0; i < count; i++) {
    typeIndices.push(reader.readU32Leb128());
  }

  return typeIndices;
}

/**
 * 解析 Table section (id=4)
 */
function parseTableSection(data: Uint8Array): number {
  const reader = new BinaryReader(data);
  const count = reader.readU32Leb128();

  if (count === 0) return 0;

  // 只取第一个 table 的 initial size
  reader.readByte(); // elemtype (funcref = 0x70)
  const flags = reader.readU32Leb128();
  const initial = reader.readU32Leb128();
  // if flags & 1, there's a max
  void flags;

  return initial;
}

/**
 * 解析 Memory section (id=5)
 */
function parseMemorySection(data: Uint8Array): number {
  const reader = new BinaryReader(data);
  const count = reader.readU32Leb128();

  if (count === 0) return 0;

  const flags = reader.readU32Leb128();
  const initial = reader.readU32Leb128();
  void flags;

  return initial;
}

/**
 * 解析 Export section (id=7)
 */
function parseExportSection(data: Uint8Array): WasmExportEntry[] {
  const reader = new BinaryReader(data);
  const count = reader.readU32Leb128();
  const exports: WasmExportEntry[] = [];

  for (let i = 0; i < count; i++) {
    const name = reader.readName();
    const kindByte = reader.readByte();
    const kind = EXPORT_KIND[kindByte] || 'function';
    const index = reader.readU32Leb128();
    exports.push({ name, kind, index });
  }

  return exports;
}

/**
 * 解析 Code section (id=10) - 提取函数体信息
 */
function parseCodeSection(
  data: Uint8Array,
  funcTypeIndices: number[],
  types: { params: WasmValType[]; results: WasmValType[] }[],
  importFuncCount: number,
): WasmFunctionInfo[] {
  const reader = new BinaryReader(data);
  const count = reader.readU32Leb128();
  const functions: WasmFunctionInfo[] = [];

  for (let i = 0; i < count; i++) {
    const bodySize = reader.readU32Leb128();
    const bodyStart = reader.offset;

    // 读取 locals
    let localCount = 0;
    const localDeclCount = reader.readU32Leb128();
    for (let l = 0; l < localDeclCount; l++) {
      const n = reader.readU32Leb128();
      reader.readByte(); // valtype
      localCount += n;
    }

    // 扫描函数体中的 call 指令 (opcode 0x10)
    const callees: number[] = [];
    const codeStart = reader.offset;
    const codeEnd = bodyStart + bodySize;

    // 简易扫描 call 指令
    while (reader.offset < codeEnd) {
      const op = reader.readByte();
      if (op === 0x10) {
        // call
        const funcIdx = reader.readU32Leb128();
        if (!callees.includes(funcIdx)) {
          callees.push(funcIdx);
        }
      } else if (op === 0x11) {
        // call_indirect
        reader.readU32Leb128(); // type index
        reader.readU32Leb128(); // table index (or 0x00)
      } else if (op === 0x0b) {
        // end - 可能是函数结束
        if (reader.offset >= codeEnd) break;
      } else {
        // 跳过其他指令的操作数（简化处理）
        skipInstructionOperands(reader, op, codeEnd);
      }
    }

    reader.offset = codeEnd; // 确保指向下一个函数

    const funcIndex = importFuncCount + i;
    const typeIndex = funcTypeIndices[i] ?? 0;
    const funcType = types[typeIndex] ?? { params: [], results: [] };

    functions.push({
      index: funcIndex,
      name: `func_${funcIndex}`,
      params: funcType.params,
      results: funcType.results,
      localCount,
      bodySize,
      callees,
    });
  }

  return functions;
}

/**
 * 跳过指令操作数（简化实现，不需要完美处理所有指令）
 */
function skipInstructionOperands(reader: BinaryReader, opcode: number, maxOffset: number): void {
  if (reader.offset >= maxOffset) return;

  // Block-type instructions
  if (opcode === 0x02 || opcode === 0x03 || opcode === 0x04) {
    // block, loop, if - block type
    const bt = reader.peek();
    if (bt === 0x40) {
      reader.readByte(); // void block type
    } else if ((bt & 0x80) === 0) {
      reader.readByte(); // valtype
    } else {
      reader.readI32Leb128(); // type index (s33)
    }
    return;
  }

  // Branch instructions
  if (opcode === 0x0c || opcode === 0x0d) {
    reader.readU32Leb128(); // label index
    return;
  }
  if (opcode === 0x0e) {
    // br_table
    const count = reader.readU32Leb128();
    for (let i = 0; i <= count; i++) {
      reader.readU32Leb128();
    }
    return;
  }

  // Variable instructions
  if (opcode >= 0x20 && opcode <= 0x24) {
    reader.readU32Leb128(); // local/global index
    return;
  }

  // Memory instructions
  if (opcode >= 0x28 && opcode <= 0x3e) {
    reader.readU32Leb128(); // align
    reader.readU32Leb128(); // offset
    return;
  }
  if (opcode === 0x3f || opcode === 0x40) {
    reader.readByte(); // memory index (0x00)
    return;
  }

  // i32.const
  if (opcode === 0x41) {
    reader.readI32Leb128();
    return;
  }
  // i64.const
  if (opcode === 0x42) {
    reader.readI64Leb128();
    return;
  }
  // f32.const
  if (opcode === 0x43) {
    reader.skip(4);
    return;
  }
  // f64.const
  if (opcode === 0x44) {
    reader.skip(8);
    return;
  }

  // 0xFC prefix instructions
  if (opcode === 0xfc) {
    const sub = reader.readU32Leb128();
    if (sub >= 8 && sub <= 11) {
      // memory.init, data.drop, memory.copy, memory.fill
      if (sub === 8) { reader.readU32Leb128(); reader.readByte(); }
      else if (sub === 9) { reader.readU32Leb128(); }
      else if (sub === 10) { reader.readByte(); reader.readByte(); }
      else if (sub === 11) { reader.readByte(); }
    } else if (sub <= 7) {
      // i32.trunc_sat_* - no operands
    }
    return;
  }

  // Most numeric/comparison instructions have no operands
}

/**
 * 解析 Data section (id=11)
 */
function parseDataSection(data: Uint8Array): { offset: number; data: Uint8Array }[] {
  const reader = new BinaryReader(data);
  const count = reader.readU32Leb128();
  const segments: { offset: number; data: Uint8Array }[] = [];

  for (let i = 0; i < count; i++) {
    const flags = reader.readU32Leb128();

    let segOffset = 0;
    if (flags === 0) {
      // Active, memory 0, expr
      // Read init_expr (i32.const N end)
      const op = reader.readByte();
      if (op === 0x41) {
        segOffset = reader.readI32Leb128();
      }
      // skip to end opcode
      while (reader.offset < data.length && reader.readByte() !== 0x0b) { /* skip */ }
    } else if (flags === 1) {
      // Passive
    } else if (flags === 2) {
      // Active with memory index
      reader.readU32Leb128(); // memory index
      const op = reader.readByte();
      if (op === 0x41) {
        segOffset = reader.readI32Leb128();
      }
      while (reader.offset < data.length && reader.readByte() !== 0x0b) { /* skip */ }
    }

    const size = reader.readU32Leb128();
    const segData = reader.readBytes(size);
    segments.push({ offset: segOffset, data: segData });
  }

  return segments;
}

/**
 * 解析 Custom section - 提取 name
 */
function parseCustomSectionName(data: Uint8Array): string {
  const reader = new BinaryReader(data);
  try {
    return reader.readName();
  } catch {
    return 'unknown';
  }
}

// ─── Main Parse Function ───

/**
 * 解析完整的 WASM 模块
 */
export function parseModule(binary: Uint8Array): ParsedWasmModule {
  if (!validateWasmBinary(binary)) {
    throw new Error('[WasmParser] Invalid WASM binary: bad magic number or version');
  }

  const sections = parseSections(binary);

  // 版本
  const version = new DataView(binary.buffer, binary.byteOffset + 4, 4).getUint32(0, true);

  // 按 section ID 提取
  let types: { params: WasmValType[]; results: WasmValType[] }[] = [];
  let imports: WasmImportEntry[] = [];
  let funcTypeIndices: number[] = [];
  let exports: WasmExportEntry[] = [];
  let functions: WasmFunctionInfo[] = [];
  let memoryPages = 0;
  let tableSize = 0;
  const customSections: string[] = [];
  let dataSegments: { offset: number; data: Uint8Array }[] = [];

  for (const section of sections) {
    try {
      switch (section.id) {
        case 0: // Custom
          customSections.push(parseCustomSectionName(section.data));
          break;
        case 1: // Type
          types = parseTypeSection(section.data);
          break;
        case 2: // Import
          imports = parseImportSection(section.data);
          break;
        case 3: // Function
          funcTypeIndices = parseFunctionSection(section.data);
          break;
        case 4: // Table
          tableSize = parseTableSection(section.data);
          break;
        case 5: // Memory
          memoryPages = parseMemorySection(section.data);
          break;
        case 7: // Export
          exports = parseExportSection(section.data);
          break;
        case 10: // Code
          {
            const importFuncCount = imports.filter((imp) => imp.kind === 'function').length;
            functions = parseCodeSection(section.data, funcTypeIndices, types, importFuncCount);
          }
          break;
        case 11: // Data
          dataSegments = parseDataSection(section.data);
          break;
      }
    } catch (err) {
      // Section parse error - continue with other sections
      console.warn(`[WasmParser] Error parsing section ${section.name}:`, err);
    }
  }

  // 如果 memory 来自 import 且本地没有 memory section
  if (memoryPages === 0) {
    const memImport = imports.find((i) => i.kind === 'memory');
    if (memImport) {
      memoryPages = 1; // 默认至少1页
    }
  }

  // 用 export name 更新 function names
  for (const exp of exports) {
    if (exp.kind === 'function') {
      const func = functions.find((f) => f.index === exp.index);
      if (func) {
        func.name = exp.name;
      }
    }
  }

  return {
    version,
    sections,
    types,
    imports,
    exports,
    functions,
    memoryPages,
    tableSize,
    customSections,
    dataSegments,
  };
}

// ─── Disassembly ───

/** WASM opcode 助记符映射（常用子集） */
const OPCODE_MNEMONICS: Record<number, string> = {
  0x00: 'unreachable', 0x01: 'nop',
  0x02: 'block', 0x03: 'loop', 0x04: 'if', 0x05: 'else', 0x0b: 'end',
  0x0c: 'br', 0x0d: 'br_if', 0x0e: 'br_table', 0x0f: 'return',
  0x10: 'call', 0x11: 'call_indirect',
  0x1a: 'drop', 0x1b: 'select',
  0x20: 'local.get', 0x21: 'local.set', 0x22: 'local.tee',
  0x23: 'global.get', 0x24: 'global.set',
  0x28: 'i32.load', 0x29: 'i64.load', 0x2a: 'f32.load', 0x2b: 'f64.load',
  0x2c: 'i32.load8_s', 0x2d: 'i32.load8_u', 0x2e: 'i32.load16_s', 0x2f: 'i32.load16_u',
  0x30: 'i64.load8_s', 0x31: 'i64.load8_u', 0x32: 'i64.load16_s', 0x33: 'i64.load16_u',
  0x34: 'i64.load32_s', 0x35: 'i64.load32_u',
  0x36: 'i32.store', 0x37: 'i64.store', 0x38: 'f32.store', 0x39: 'f64.store',
  0x3a: 'i32.store8', 0x3b: 'i32.store16', 0x3c: 'i64.store8', 0x3d: 'i64.store16', 0x3e: 'i64.store32',
  0x3f: 'memory.size', 0x40: 'memory.grow',
  0x41: 'i32.const', 0x42: 'i64.const', 0x43: 'f32.const', 0x44: 'f64.const',
  0x45: 'i32.eqz', 0x46: 'i32.eq', 0x47: 'i32.ne',
  0x48: 'i32.lt_s', 0x49: 'i32.lt_u', 0x4a: 'i32.gt_s', 0x4b: 'i32.gt_u',
  0x4c: 'i32.le_s', 0x4d: 'i32.le_u', 0x4e: 'i32.ge_s', 0x4f: 'i32.ge_u',
  0x67: 'i32.clz', 0x68: 'i32.ctz', 0x69: 'i32.popcnt',
  0x6a: 'i32.add', 0x6b: 'i32.sub', 0x6c: 'i32.mul',
  0x6d: 'i32.div_s', 0x6e: 'i32.div_u', 0x6f: 'i32.rem_s', 0x70: 'i32.rem_u',
  0x71: 'i32.and', 0x72: 'i32.or', 0x73: 'i32.xor',
  0x74: 'i32.shl', 0x75: 'i32.shr_s', 0x76: 'i32.shr_u', 0x77: 'i32.rotl', 0x78: 'i32.rotr',
  0x7c: 'i64.add', 0x7d: 'i64.sub', 0x7e: 'i64.mul',
  0x83: 'i64.and', 0x84: 'i64.or', 0x85: 'i64.xor',
  0x86: 'i64.shl', 0x87: 'i64.shr_s', 0x88: 'i64.shr_u', 0x89: 'i64.rotl', 0x8a: 'i64.rotr',
};

/**
 * 反汇编函数体字节码为指令列表
 */
export function decodeFunctionBody(bodyBytes: Uint8Array, maxInstructions = 500): WasmInstruction[] {
  const reader = new BinaryReader(bodyBytes);
  const instructions: WasmInstruction[] = [];

  // 跳过 locals 声明
  const localDeclCount = reader.readU32Leb128();
  for (let i = 0; i < localDeclCount; i++) {
    reader.readU32Leb128(); // count
    reader.readByte(); // valtype
  }

  while (reader.remaining > 0 && instructions.length < maxInstructions) {
    const instrOffset = reader.offset;
    const opcode = reader.readByte();
    const mnemonic = OPCODE_MNEMONICS[opcode] || `0x${opcode.toString(16).padStart(2, '0')}`;
    const operands: (number | string)[] = [];

    // 解析操作数
    if (opcode === 0x02 || opcode === 0x03 || opcode === 0x04) {
      const bt = reader.readByte();
      if (bt === 0x40) operands.push('void');
      else operands.push(VALTYPE_MAP[bt] || `type:${bt}`);
    } else if (opcode === 0x0c || opcode === 0x0d) {
      operands.push(reader.readU32Leb128());
    } else if (opcode === 0x0e) {
      const count = reader.readU32Leb128();
      for (let i = 0; i <= count; i++) {
        operands.push(reader.readU32Leb128());
      }
    } else if (opcode >= 0x20 && opcode <= 0x24) {
      operands.push(reader.readU32Leb128());
    } else if (opcode >= 0x28 && opcode <= 0x3e) {
      const align = reader.readU32Leb128();
      const offset = reader.readU32Leb128();
      operands.push(`align=${align}`);
      operands.push(`offset=${offset}`);
    } else if (opcode === 0x3f || opcode === 0x40) {
      operands.push(reader.readByte());
    } else if (opcode === 0x41) {
      operands.push(reader.readI32Leb128());
    } else if (opcode === 0x42) {
      operands.push(Number(reader.readI64Leb128()));
    } else if (opcode === 0x43) {
      operands.push(reader.readF32());
    } else if (opcode === 0x44) {
      operands.push(reader.readF64());
    } else if (opcode === 0x10) {
      operands.push(reader.readU32Leb128());
    } else if (opcode === 0x11) {
      operands.push(reader.readU32Leb128()); // type index
      operands.push(reader.readU32Leb128()); // table index
    }

    instructions.push({ offset: instrOffset, opcode, mnemonic, operands });

    if (opcode === 0x0b && reader.remaining === 0) break; // end of function
  }

  return instructions;
}

// ─── Crypto Detection ───

/**
 * 在 WASM 模块的 Data section 和 Code section 常量中扫描加密算法特征
 */
export function detectCryptoConstants(module: ParsedWasmModule): CryptoSignature[] {
  const signatures: CryptoSignature[] = [];

  // 合并所有 Data segment 和 Code section 中的 i32.const 常量用于扫描
  const allDataBytes: Uint8Array[] = module.dataSegments.map((seg) => seg.data);

  // 从 Code section 提取 i32.const 常量值
  const codeConstants: number[] = [];
  const codeSection = module.sections.find((s) => s.id === 10);
  if (codeSection) {
    // 简单扫描 0x41 后的 LEB128 值
    for (let i = 0; i < codeSection.data.length - 1; i++) {
      if (codeSection.data[i] === 0x41) {
        // 尝试读取 i32 LEB128
        let result = 0;
        let shift = 0;
        let j = i + 1;
        let byte: number;
        let valid = true;
        do {
          if (j >= codeSection.data.length) { valid = false; break; }
          byte = codeSection.data[j++];
          result |= (byte & 0x7f) << shift;
          shift += 7;
          if (shift > 35) { valid = false; break; }
        } while (byte & 0x80);
        if (valid) {
          codeConstants.push(result >>> 0);
        }
      }
    }
  }

  // ─── 检查 AES S-Box ───
  const aesEvidence: string[] = [];
  for (const dataBytes of allDataBytes) {
    if (containsSequence(dataBytes, AES_SBOX_PREFIX)) {
      aesEvidence.push('AES S-Box found in data segment');
    }
  }
  if (aesEvidence.length > 0) {
    signatures.push({ type: 'AES', confidence: 0.9, evidence: aesEvidence });
  }

  // ─── 检查 SHA-256 ───
  const sha256Evidence: string[] = [];
  const sha256IVFound = SHA256_IV.filter((iv) => codeConstants.includes(iv));
  if (sha256IVFound.length >= 4) {
    sha256Evidence.push(`SHA-256 IV constants found: ${sha256IVFound.length}/8`);
  }
  const sha256KFound = SHA256_K_PREFIX.filter((k) => codeConstants.includes(k));
  if (sha256KFound.length >= 4) {
    sha256Evidence.push(`SHA-256 K constants found: ${sha256KFound.length}/8`);
  }
  if (sha256Evidence.length > 0) {
    signatures.push({
      type: 'SHA256',
      confidence: Math.min(0.95, 0.4 + sha256IVFound.length * 0.08 + sha256KFound.length * 0.05),
      evidence: sha256Evidence,
    });
  }

  // ─── 检查 ChaCha20 ───
  const chachaEvidence: string[] = [];
  const chachaFound = CHACHA_SIGMA.filter((c) => codeConstants.includes(c));
  if (chachaFound.length >= 3) {
    chachaEvidence.push(`ChaCha20 sigma constants found: ${chachaFound.length}/4`);
  }
  // 检查 ARX 模式 (add-rotate-xor)
  if (hasARXPattern(codeConstants)) {
    chachaEvidence.push('ARX (Add-Rotate-XOR) pattern detected');
  }
  if (chachaEvidence.length > 0) {
    signatures.push({
      type: 'ChaCha20',
      confidence: Math.min(0.9, 0.3 + chachaFound.length * 0.15),
      evidence: chachaEvidence,
    });
  }

  // ─── 检查 SM3 ───
  const sm3Evidence: string[] = [];
  const sm3Found = SM3_IV.filter((iv) => codeConstants.includes(iv));
  if (sm3Found.length >= 4) {
    sm3Evidence.push(`SM3 IV constants found: ${sm3Found.length}/8`);
    signatures.push({
      type: 'SM3',
      confidence: Math.min(0.9, 0.4 + sm3Found.length * 0.08),
      evidence: sm3Evidence,
    });
  }

  // ─── 检查 SM4 ───
  const sm4Evidence: string[] = [];
  const sm4Found = SM4_FK.filter((fk) => codeConstants.includes(fk));
  if (sm4Found.length >= 2) {
    sm4Evidence.push(`SM4 FK constants found: ${sm4Found.length}/4`);
    signatures.push({
      type: 'SM4',
      confidence: Math.min(0.85, 0.3 + sm4Found.length * 0.15),
      evidence: sm4Evidence,
    });
  }

  // ─── 检查 MD5 ───
  const md5Evidence: string[] = [];
  const md5Found = MD5_T_PREFIX.filter((t) => codeConstants.includes(t));
  if (md5Found.length >= 2) {
    md5Evidence.push(`MD5 T-table constants found: ${md5Found.length}/4`);
    signatures.push({
      type: 'MD5',
      confidence: Math.min(0.85, 0.35 + md5Found.length * 0.15),
      evidence: md5Evidence,
    });
  }

  return signatures;
}

/**
 * 检查字节序列是否包含指定子序列
 */
function containsSequence(haystack: Uint8Array, needle: number[]): boolean {
  if (haystack.length < needle.length) return false;
  outer:
  for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * 检测 ARX (Add-Rotate-XOR) 模式 —— ChaCha/Blake 特征
 * 如果 i32.add、i32.rotl/rotr、i32.xor 三者频繁出现
 */
function hasARXPattern(constants: number[]): boolean {
  // ARX 模式通过旋转位数识别
  // ChaCha20 使用旋转 16, 12, 8, 7
  const chachaRotations = [16, 12, 8, 7];
  const found = chachaRotations.filter((r) => constants.includes(r));
  return found.length >= 3;
}

// ─── Convenience Exports ───

/**
 * 快速提取 WASM 模块元数据（用于 extract_wasm tool）
 */
export function extractModuleMetadata(binary: Uint8Array): {
  exports: string[];
  imports: { module: string; name: string; kind: string }[];
  memoryPages: number;
  tableSize: number;
  customSections: string[];
} {
  const module = parseModule(binary);
  return {
    exports: module.exports.map((e) => e.name),
    imports: module.imports.map((i) => ({ module: i.module, name: i.name, kind: i.kind })),
    memoryPages: module.memoryPages,
    tableSize: module.tableSize,
    customSections: module.customSections,
  };
}
