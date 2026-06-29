# WebTrace MCP 能力验证报告 — 知乎场景

## 验证日期
2026-06-29

## 验证方法
代码走查 + 模拟调用逻辑分析

### 被验证对象
- WebTrace Extension 11 个 MCP Tool
- 知乎反爬机制：zse-ck Challenge + WASM cookie 生成

### 知乎反爬机制摘要
1. 访问知乎页面时返回 Challenge 页，包含 `<meta id="zh-zse-ck" content="...">`
2. Challenge 页加载 `https://static.zhihu.com/zse-ck/v4/XXXX.js`（emo.js）
3. emo.js 内含 WASM 模块，调用 `WebAssembly.instantiate` 执行加密计算
4. 计算结果通过 `document.cookie` 写入 `__zse_ck=005_...` cookie
5. 带有效 cookie 再次请求即获得正常页面内容

---

## 逐 Tool 验证结果

### page_state ✗ (部分通过)

**能力验证：**
- ✓ 能获取页面所有 script 标签信息（src 含 `static.zhihu.com/zse-ck/v4/...`）
- ✓ 能通过 Performance API 列出 emo.js 的网络请求
- ✓ 能通过 chrome.cookies API 获取 `__zse_ck` cookie
- ✗ **无法获取 zh-zse-ck meta 内容**

**发现的 Bug：**
`page_state` 的 meta 提取逻辑只检查 `name`/`property`/`http-equiv` 属性：
```typescript
const name = m.getAttribute('name') || m.getAttribute('property') || m.getAttribute('http-equiv');
```
但知乎的关键 meta 标签使用 `id` 属性：`<meta id="zh-zse-ck" content="...">`。
这导致 **最关键的 Challenge 参数无法被 page_state 捕获**。

**修复建议：** meta 提取应补充 `m.getAttribute('id')` 或 `m.id` 作为 fallback key。

---

### detect_protection ✓

**能力验证：**
- ✓ 正则 `zh[-_]?zse[-_]?ck` 能匹配 HTML 中的 `zh-zse-ck` → 识别为 "Zhihu ZSE Challenge"
- ✓ 正则 `static\.zhihu\.com\/zse-ck\/` 能匹配 CDN script 标签 → "Zhihu ZSE CDN"
- ✓ HTML 中 inline script 含 WASM 相关代码时可触发 "WebAssembly usage" 检测
- ✓ 综合判定逻辑能正确给出 `type: 'combined'` 或 `type: 'wasm'`, level 4-5

**模拟调用结果：**
```
输入: detect_protection() [当前页为知乎 Challenge 页]
预期输出:
  type: 'wasm' 或 'combined'
  level: 4-5
  features: ['Zhihu ZSE Challenge', 'Zhihu ZSE CDN', 'WebAssembly usage']
  confidence: 0.45+
```

**局限性：**
- 当前页模式只获取 `outerHTML` + inline scripts，不会下载 emo.js 分析内容
- 无法检测 emo.js 中的 JSVMP 特征（while-switch 在外部脚本中）
- 建议：如果 script 列表中有可疑的大文件，提示用户用 `analyze_jsvmp` 进一步分析

**结论：** 对知乎场景有效，能正确识别保护类型。

---

### extract_wasm ✗ (有条件通过)

**能力验证：**
- ✗ `scriptUrl` 模式指向 emo.js URL 时 **会失败** — emo.js 是 JavaScript 文件，首字节不是 WASM magic number `\0asm`，`validateWasmBinary` 会返回 false
- ✓ `pageContext` 模式原理正确 — Hook `WebAssembly.instantiate` 后能捕获 binary
- ⚠ Hook 时序问题 — 第一次调用设置 Hook，此时 emo.js 可能已经加载完毕

**核心问题：**
1. **URL 模式不适用于知乎** — 知乎的 WASM 是嵌入在 emo.js 内部的 ArrayBuffer/Uint8Array，不是独立 .wasm 文件
2. **pageContext 模式需要两步操作**：
   - 第 1 次调用：设置 Hook（返回空结果）
   - 页面需要 **刷新** 才能让 Hook 生效
   - 第 2 次调用：读取捕获数据
3. **只保留前 64KB 用于解析** — 如果知乎 WASM 模块的关键 section 在 64KB 之后，元数据会不完整

**正确使用流程：**
```
1. hook_api("WebAssembly.instantiate", "observe") → 设置拦截
2. 刷新页面 → emo.js 加载触发 Hook
3. extract_wasm({pageContext: true}) → 获取捕获的 WASM binary
```

**结论：** URL 模式对知乎无效；pageContext 模式可行但需要页面刷新。

---

### analyze_wasm ✓

**能力验证：**
- ✓ WASM magic number 验证逻辑正确
- ✓ Section 解析完整覆盖所有标准 section (0-12)
- ✓ 加密算法检测覆盖 SHA-256、AES、ChaCha20、SM3/SM4、MD5
- ✓ 函数调用图（callees）提取逻辑正确
- ✓ 反汇编输出格式为 WAT 子集，可读性好
- ✓ LEB128 编码解析正确处理了溢出保护

**知乎场景适用性：**
知乎 WASM 模块很可能使用 SHA-256 算法（从 cookie 005_ 前缀和已知分析推断）。
`detectCryptoConstants` 能通过以下方式识别：
- 扫描 Data section 中的 AES S-Box 字节序列
- 扫描 Code section 中的 `i32.const` 指令携带的 SHA-256 IV/K 常量
- ChaCha20 sigma 常量检测 + ARX 旋转位数模式

**潜在风险：**
- 如果只获取了前 64KB（来自 extract_wasm 的截断），Code section 可能不完整
- `skipInstructionOperands` 是简化实现，遇到非标准扩展指令可能错位

**结论：** 算法检测逻辑严谨，对知乎 WASM 加密分析有效。

---

### dump_wasm_memory ✗

**能力验证：**
- ✓ 边界检查逻辑正确（offset >= totalSize 报错）
- ✓ 多编码格式输出（hex/utf8/base64/uint8）实现完整
- ✓ actualLength 自动截断避免越界
- ✗ **内存引用获取链路断裂**

**发现的严重 Bug：**
`dump_wasm_memory` 依赖两个数据源获取 `WebAssembly.Memory`：
1. `window.__wt_wasm_instances` — **没有任何 Tool 会设置此变量**
2. `window.__wt_wasm_captured[].memory` — extract_wasm Hook 代码只存储 `source`、`bytes`、`size`，**无 memory 字段**

**根因分析：**
- `extract_wasm` Hook 代码捕获的是传入参数的字节副本，不是实例化后的 Instance
- `hook_api("WebAssembly.instantiate")` 通用 Proxy 只记录调用日志，不存储 Instance/Memory 引用
- 整个工具链中没有任何地方将 `WebAssembly.Instance.exports.memory` 存储到 `__wt_wasm_instances`

**影响：** `dump_wasm_memory` 在当前版本中 **完全无法工作**，对知乎和任何场景都会返回 "No WASM memory instance found"。

**修复建议：**
在 `extract_wasm` 的 Hook 代码中，对 `WebAssembly.instantiate` 返回的 Promise 进行 `.then()` 拦截：
```typescript
return origInstantiate.call(WebAssembly, bufferSource, importObject).then(result => {
  const instance = result.instance || result;
  const memory = instance.exports.memory;
  if (memory) {
    window.__wt_wasm_instances = window.__wt_wasm_instances || [];
    window.__wt_wasm_instances.push({ id: 'inst_' + Date.now(), instance, memory });
  }
  return result;
});
```

---

### hook_api（增强版）✓ (部分通过)

**能力验证：**

| Hook 目标 | 可行性 | 说明 |
|-----------|--------|------|
| `fetch` | ✓ | Proxy 正确包装 apply，args 含 Request/init |
| `crypto.subtle.digest` | ✓ | 路径解析 `crypto.subtle.digest` 正确 |
| `WebAssembly.instantiate` | ✓ | 能拦截 WASM 实例化，args 含 ArrayBuffer |
| `document.cookie` | ✓ | 特殊分支处理 getter/setter，能捕获 `__zse_ck` 写入 |

**发现的问题：**

1. **captureRequestHeaders 等选项是空声明：**
   Schema 中定义了 `captureRequestHeaders`、`captureResponseHeaders`、`captureRequestBody`、`captureResponseBody`，但注入到页面的 `hookConfig.options` 只传递了 `captureArgs`、`captureResult`、`maxLogs`。这些扩展选项 **永远不会生效**。

2. **fetch Response 不可序列化：**
   对于 `hook_api("fetch")`，Promise resolve 的值是 Response 对象。当 `captureResult: true` 时，entry.result 存储 Response 对象。后续 `get_hook_logs` 通过 `chrome.scripting.executeScript` 读取时，Response 对象 **无法被结构化克隆**，可能导致数据丢失或报错。

3. **捕获参数无大小限制：**
   `hook_api("WebAssembly.instantiate")` 会将完整的 ArrayBuffer 存入 logs.args。对于数 MB 的 WASM binary，这会严重占用内存且 get_hook_logs 序列化时可能失败。

**知乎场景模拟：**
```
hook_api("document.cookie", "observe") → 设置 Hook
[emo.js 执行后通过 document.cookie = "__zse_ck=005_..." 写入]
get_hook_logs() → 能看到:
  { apiName: "document.cookie[set]", args: ["__zse_ck=005_xxx;path=/;expires=..."], timestamp: ... }
```
**结论：** cookie 监控核心流程可行；网络请求头捕获功能名不副实。

---

### get_hook_logs ✓

**能力验证：**
- ✓ 从页面 MAIN world 读取 `window.__wt_hook_${id}` 存储的日志
- ✓ 支持按 hookId、apiName、timeRange 过滤
- ✓ 按时间倒序排列
- ✓ 支持 limit 限制返回条数
- ✓ 返回 activeHooks 列表

**知乎场景适用性：**
- Challenge 页面不会主动导航，Hook 日志在页面生命周期内持续有效
- 可以过滤 `apiName: "document.cookie[set]"` 精确获取 cookie 写入记录
- 时间范围过滤可定位 WASM 执行完成的时刻

**结论：** 功能完整，适用于知乎场景。

---

### analyze_jsvmp（增强版）✓

**能力验证：**
- ✓ 分片处理逻辑 — `splitCodeIntoChunks` 在 `}\n` 边界切分，避免破坏语法
- ✓ 超时保护 — 每个 chunk 分析前检查是否超时
- ✓ `focusFunction` 参数 — 定位到指定函数名上下文后提取 chunkSize 范围代码
- ✓ 多模式识别 — while-switch、handler-table、字节码数组等特征

**知乎场景模拟：**
```
输入: analyze_jsvmp(emo_js_code, { chunkSize: 100000 })
emo.js 约 300-500KB → 分为 3-5 个 chunks
每个 chunk 独立进行 AST 分析 → detectVMDispatchers
预期输出:
  dispatchers: [{ type: 'while-switch', opcodeCount: 200+, ... }]
  structure: { patterns: ['while-switch'], largestDispatcher: 200+ }
```

**潜在问题：**
- 分片后某个 chunk 可能不是完整的 JavaScript（即使在 `}\n` 处切分），AST parse 可能失败
- 失败的 chunk 会被 catch 跳过，不影响其他 chunk（容错设计正确）
- `focusFunction` 参数类型是 `string`（函数名），任务描述中 `focusFunction:true` 是错误用法

**结论：** 分片+超时机制对大文件如 emo.js 有效。

---

### trace_execution ⚠ (知乎场景有限)

**能力验证：**
- ✓ QuickJS WASM 沙箱执行隔离正确
- ✓ 超时保护 + trace 条目上限
- ✓ 大代码分片截断（取最后 chunk）
- ✓ 通过 chrome.runtime.sendMessage 与 Offscreen Document 通信

**知乎场景局限：**
- ❌ QuickJS 沙箱 **无 WebAssembly 支持** — emo.js 核心逻辑依赖 WASM
- ❌ 沙箱 **无 DOM/document/navigator** — emo.js 需要读取 `document.getElementById('zh-zse-ck')`
- ❌ 沙箱 **无 fetch/网络** — emo.js 可能有网络请求

**结论：** 不适用于直接执行完整 emo.js。可用于已提取的纯 JS 计算片段（如 JSVMP 字节码解释器的局部逻辑）。

---

### deobfuscate ✓

**能力验证：**
- ✓ 自动模式多轮迭代（最多 5 轮）
- ✓ 手动模式支持 10 种变换
- ✓ 超时保护（MCP_TOOL_TIMEOUT - 5s）
- ✓ 输出统计信息（缩减比例、迭代次数）

**知乎场景适用性：**
emo.js 使用的混淆特征：
- 十六进制字符串编码 → `hex-numeric` 变换可处理
- Unicode 转义 → `unicode-escape` 可处理
- 短变量名 → `rename` 可部分还原
- 控制流平坦化 → `control-flow` 可尝试还原

**注意事项：**
- emo.js 过大时（>200KB）建议先用 `analyze_jsvmp` 定位关键函数，再对片段反混淆
- JSVMP 保护的核心逻辑无法通过静态反混淆还原（设计如此）
- 反混淆是辅助手段，需配合 `trace_execution` 获取运行时语义

**结论：** 对 emo.js 片段的预处理有效，可提高后续分析的可读性。

---

## 完整工作流可行性

### Phase 1: 侦查 — ⚠ 部分可行

```
page_state() 
  → ✓ 能列出 emo.js script URL
  → ✓ 能获取 cookies（看是否已有 __zse_ck）
  → ✗ 无法获取 zh-zse-ck meta content（Bug）

detect_protection()
  → ✓ 能正确识别 "Zhihu ZSE Challenge" + "Zhihu ZSE CDN"
  → ✓ protection level 评估正确
```

### Phase 2: WASM 分析 — ✗ 链路不通

```
extract_wasm(scriptUrl=emo_js_url)
  → ✗ emo.js 不是 .wasm 文件，magic number 检查失败

extract_wasm({pageContext: true})
  → ⚠ 需要先刷新页面才能捕获（Hook 设置后 WASM 才加载时有效）
  → ⚠ 第一次调用只设置 Hook，返回空
  → 需要手动页面刷新流程

analyze_wasm(captured_binary)
  → ✓ 如果拿到 binary，解析和加密检测正确

dump_wasm_memory(offset, length)
  → ✗ 完全无法工作 — 没有 tool 会存储 Memory 引用
```

### Phase 3: 动态监控 — ✓ 核心流程可行

```
hook_api("document.cookie", "observe")
  → ✓ 能捕获 __zse_ck 写入

hook_api("WebAssembly.instantiate", "observe")
  → ✓ 能拦截 WASM 实例化调用

get_hook_logs({filter: {apiName: "cookie"}})
  → ✓ 能获取 cookie 写入日志
```

### Phase 4: 代码分析 — ✓ 基本可行

```
analyze_jsvmp(emo_js, {chunkSize: 100000})
  → ✓ 分片分析能识别 VM 派发循环

deobfuscate(emo_js_snippet)
  → ✓ 能对代码片段做预处理

trace_execution(isolated_snippet)
  → ⚠ 只能执行纯计算片段，不能执行完整 emo.js
```

---

## 发现的问题和 Bug

### 严重 (P0)

| # | 工具 | 问题 | 影响 |
|---|------|------|------|
| 1 | dump_wasm_memory | Memory 引用获取链断裂 — `__wt_wasm_instances` 无人写入 | 工具完全无法使用 |
| 2 | page_state | meta 只提取 name/property/http-equiv 属性，漏掉 id 属性 | 知乎 Challenge 参数丢失 |

### 中等 (P1)

| # | 工具 | 问题 | 影响 |
|---|------|------|------|
| 3 | hook_api | captureRequestHeaders 等 4 个选项声明但未传递到注入代码 | 功能名不副实 |
| 4 | extract_wasm | scriptUrl 模式不支持从 JS 文件中提取嵌入的 WASM | 知乎场景 URL 模式无效 |
| 5 | hook_api | fetch Hook 的 Response 对象无法被结构化克隆 | get_hook_logs 读取时可能失败 |

### 低 (P2)

| # | 工具 | 问题 | 影响 |
|---|------|------|------|
| 6 | hook_api | WebAssembly.instantiate Hook 的 args 含完整 binary 无大小限制 | 内存膨胀 |
| 7 | extract_wasm | pageContext Hook 需要页面刷新才生效，用户体验不佳 | 操作流程多一步 |
| 8 | trace_execution | 大代码截断只取最后 chunk，可能丢失关键声明 | 部分场景执行失败 |

---

## 改进建议

### 短期修复（影响知乎端到端流程）

1. **page_state meta 提取增加 id 属性**
   ```typescript
   const name = m.getAttribute('name') || m.getAttribute('property') 
     || m.getAttribute('http-equiv') || m.getAttribute('id');
   ```

2. **extract_wasm Hook 代码增加 Instance/Memory 存储**
   在 `WebAssembly.instantiate` 的返回 Promise 中 `.then()` 拦截，将 instance.exports.memory 存入 `__wt_wasm_instances`。

3. **hook_api 传递完整 options 到注入代码**
   将 `captureRequestHeaders` 等选项传入 hookConfig.options，并在 fetch Proxy 中实现请求头/响应头提取。

### 中期增强

4. **extract_wasm 增加 "从 JS 中提取嵌入 WASM" 模式**
   - 下载 JS 文件后，扫描 `new Uint8Array([0x00, 0x61, 0x73, 0x6d, ...])` 模式
   - 或查找 base64 编码的 WASM binary

5. **hook_api 对 fetch/XHR 做特殊处理**
   - fetch：clone Response 后读取 headers 和 body
   - Args 大小限制：对 ArrayBuffer 类型只保留前 N 字节

6. **extract_wasm 的 Hook 应自动拦截实例化结果**
   当前 Hook 只在 `instantiate` 调用时记录 bytes，应改为在 Promise resolve 后同时记录 exports。

### 长期方向

7. **增加 WASM 运行时 Hook 能力**（函数级别的 wrap_export）
8. **增加 "replay" 模式**（记录 WASM 输入，在沙箱中重放）
9. **trace_execution 增加最小化的浏览器环境模拟**（类似知乎项目 zse_ck.js 的方式）

---

## 总体结论

### 覆盖度评估

| 阶段 | 覆盖度 | 评价 |
|------|--------|------|
| 侦查（识别保护） | **80%** | detect_protection 准确；page_state 有 Bug |
| WASM 分析（静态） | **60%** | analyze_wasm 强大但 extract 链路有缺口 |
| WASM 分析（动态） | **0%** | dump_wasm_memory 完全不工作 |
| 动态 Hook 监控 | **75%** | cookie/API Hook 核心可用；请求头选项空声明 |
| 代码分析 | **85%** | analyze_jsvmp + deobfuscate 组合有效 |
| 沙箱执行 | **30%** | trace_execution 不适用于需要浏览器环境的代码 |

### 端到端可行性

**当前版本在知乎场景的核心流程（识别保护→监控 cookie 写入→分析代码结构）是可行的。**

但以下关键能力存在断裂：
- WASM 内存分析链路完全不通（P0 Bug）
- 从 JS 文件提取嵌入 WASM 的路径不支持
- meta tag 获取遗漏影响自动化侦查

**修复 P0/P1 问题后，WebTrace 对知乎反爬场景的覆盖度可从当前的约 55% 提升到 85%+。**
