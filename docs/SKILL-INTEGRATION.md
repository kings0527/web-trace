# WebTrace MCP Server 集成指南

## 概述

WebTrace 是一个 Chrome/Edge Extension，通过 MCP（Model Context Protocol）协议暴露 Web 逆向分析能力。AI Agent（Qoder/Cursor/Claude Code 等）可通过 MCP 连接 WebTrace 获取以下能力：

- **JSVMP 自动识别与字节码追踪** — 检测虚拟机保护并分析派发循环结构
- **页面保护类型检测** — 识别 Cloudflare、瑞数、同盾等 Challenge 特征
- **JS 反混淆** — 多种变换自动/手动还原混淆代码
- **API Hook 与日志收集** — 隐蔽 Proxy Hook 监控浏览器 API 调用
- **页面状态查询** — 获取 Cookie、Storage、脚本列表、网络请求等

---

## 连接方式

### 方式1：Chrome Runtime Port（推荐，Extension 内部 Agent）

适用于运行在同一浏览器中的 AI Agent 扩展或 DevTools 面板。

```javascript
// Agent side: connect to WebTrace MCP Server
const port = chrome.runtime.connect(
  'WEBTRACE_EXTENSION_ID', // Replace with actual extension ID
  { name: 'webtrace-mcp' }
);

// Send JSON-RPC message
function sendMCPRequest(method, params, id) {
  port.postMessage({
    jsonrpc: '2.0',
    id: id,
    method: method,
    params: params,
  });
}

// Receive JSON-RPC response
port.onMessage.addListener((message) => {
  console.log('MCP Response:', message);
});

// Example: call detect_protection
sendMCPRequest('tools/call', {
  name: 'detect_protection',
  arguments: { url: 'https://target-site.com' },
}, 1);
```

**获取 Extension ID：**
- 开发模式：`chrome://extensions` 页面查看已加载扩展的 ID
- 生产模式：Chrome Web Store 安装后自动分配

### 方式2：WebSocket（外部 Agent）

适用于 Python/Node.js 等外部进程中运行的 AI Agent。需要一个本机 bridge 进程转发 WebSocket 消息。

**架构：** `AI Agent → ws://127.0.0.1:3100/mcp → Bridge → Extension Service Worker`

```python
# Python Agent via websocket
import asyncio
import websockets
import json

async def mcp_client():
    uri = "ws://127.0.0.1:3100/mcp"
    async with websockets.connect(uri) as ws:
        # Initialize MCP session
        await ws.send(json.dumps({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "clientInfo": {"name": "my-agent", "version": "1.0.0"},
                "capabilities": {}
            }
        }))
        response = json.loads(await ws.recv())
        print("Server capabilities:", response)

        # Call a tool
        await ws.send(json.dumps({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {
                "name": "detect_protection",
                "arguments": {}
            }
        }))
        result = json.loads(await ws.recv())
        print("Detection result:", result)

asyncio.run(mcp_client())
```

**端口发现：** 默认端口 `3100`，可通过环境变量 `WEBTRACE_MCP_PORT` 覆盖。

### 方式3：与 nodriver 协同

nodriver 启动无头 Chrome 并自动加载 WebTrace Extension，然后通过 CDP 或 WebSocket 与 Extension 交互。

```python
import nodriver as uc
import asyncio

async def main():
    # Launch Chrome with WebTrace extension loaded
    browser = await uc.start(
        browser_args=[
            '--load-extension=/path/to/WebTrace/dist',
            '--disable-extensions-except=/path/to/WebTrace/dist',
        ]
    )

    # Navigate to target page
    page = await browser.get('https://target-site.com')
    await page.sleep(3)

    # Connect to WebTrace MCP via CDP evaluateOnNewDocument
    # or use WebSocket bridge if available
    result = await page.evaluate('''
        // Access WebTrace internals via extension API
        new Promise((resolve) => {
            const port = chrome.runtime.connect(
                "WEBTRACE_EXTENSION_ID",
                { name: "webtrace-mcp" }
            );
            port.postMessage({
                jsonrpc: "2.0", id: 1,
                method: "tools/call",
                params: { name: "detect_protection", arguments: {} }
            });
            port.onMessage.addListener((msg) => resolve(msg));
        });
    ''')
    print("Protection info:", result)

asyncio.run(main())
```

详细配置请参考 [nodriver-setup.md](./nodriver-setup.md)。

### 方式4：与 patchright 协同

patchright（Playwright 反检测分支）启动浏览器并加载 WebTrace Extension。

```python
from patchright.sync_api import sync_playwright

with sync_playwright() as p:
    # Launch with extension
    context = p.chromium.launch_persistent_context(
        user_data_dir='/tmp/webtrace-profile',
        headless=False,  # Extensions require headed mode
        args=[
            '--load-extension=/path/to/WebTrace/dist',
            '--disable-extensions-except=/path/to/WebTrace/dist',
        ],
    )

    page = context.new_page()
    page.goto('https://target-site.com')
    page.wait_for_load_state('networkidle')

    # Interact with WebTrace via service worker
    # Use background page to access MCP
    background = context.service_workers[0]
    result = background.evaluate('''
        async () => {
            const { getTabStates } = await import("./background/index.js");
            return Array.from(getTabStates().entries());
        }
    ''')
    print("Tab states:", result)

    context.close()
```

详细配置请参考 [patchright-setup.md](./patchright-setup.md)。

---

## 可用工具列表

### 1. `detect_protection`

检测页面反爬/反调试保护类型和等级。

**输入参数：**
```json
{
  "url": "(optional) string - 待检测的页面URL，省略则分析当前活跃tab"
}
```

**输出格式：**
```json
{
  "type": "none | obfuscation | jsvmp | wasm | combined",
  "level": 1-5,
  "features": ["feature1", "feature2"],
  "confidence": 0.0-1.0
}
```

**使用示例：**
```json
// Request
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "detect_protection",
    "arguments": { "url": "https://www.toutiao.com" }
  }
}

// Response
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [{
      "type": "text",
      "text": "{\"type\":\"jsvmp\",\"level\":4,\"features\":[\"JSVMP dispatch loop\",\"Bytecode array\",\"TikTok-style headers\",\"Bogus parameter\"],\"confidence\":0.85}"
    }]
  }
}
```

### 2. `analyze_jsvmp`

分析 JSVMP 代码结构，识别 VM 派发循环。

**输入参数：**
```json
{
  "code": "(required) string - JSVMP代码字符串",
  "deobfuscate": "(optional) boolean - 是否先反混淆预处理，默认false"
}
```

**输出格式：**
```json
{
  "dispatchers": [{
    "type": "while-switch | while-if-else | handler-table",
    "location": { "line": 1, "column": 0 },
    "bytecodeArrayName": "varName",
    "pcVariableName": "pc",
    "opcodeCount": 128,
    "cases": { "0": "handler_0", "1": "handler_1" }
  }],
  "opcodeCount": 128,
  "structure": {
    "totalFunctions": 50,
    "largestDispatcher": 128,
    "patterns": ["while-switch"]
  }
}
```

**使用示例：**
```json
// Request
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "analyze_jsvmp",
    "arguments": {
      "code": "var _0x3f2a = [1,2,3,...]; function vm(_0x1) { var _pc=0; while(1){switch(_0x3f2a[_pc++]){case 0:...}} }",
      "deobfuscate": true
    }
  }
}

// Response
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "content": [{
      "type": "text",
      "text": "{\"dispatchers\":[{\"type\":\"while-switch\",\"location\":{\"line\":1,\"column\":42},\"bytecodeArrayName\":\"_0x3f2a\",\"pcVariableName\":\"_pc\",\"opcodeCount\":64,\"cases\":{\"0\":\"case_0\",\"1\":\"case_1\"}}],\"opcodeCount\":64,\"structure\":{\"totalFunctions\":12,\"largestDispatcher\":64,\"patterns\":[\"while-switch\"]}}"
    }]
  }
}
```

### 3. `trace_execution`

在隔离的 QuickJS WASM 沙箱中执行代码并收集 trace。

**输入参数：**
```json
{
  "code": "(required) string - 待执行的JSVMP代码",
  "inputs": "(optional) object - 注入到沙箱全局作用域的变量",
  "maxTraceEntries": "(optional) integer[100-100000] - 最大trace条目数，默认10000"
}
```

**输出格式：**
```json
{
  "traceLog": [{ "pc": 0, "opcode": 5, "stackSnapshot": [...], "timestamp": 1234567890 }],
  "executionResult": "any",
  "stats": {
    "totalEntries": 5000,
    "executionTimeMs": 1200,
    "memoryUsedBytes": 4194304,
    "truncated": false
  }
}
```

**使用示例：**
```json
// Request
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "trace_execution",
    "arguments": {
      "code": "function sign(msg){var h=0;for(var i=0;i<msg.length;i++){h=((h<<5)-h)+msg.charCodeAt(i);h|=0;}return h;}sign('test');",
      "inputs": {},
      "maxTraceEntries": 5000
    }
  }
}

// Response
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "content": [{
      "type": "text",
      "text": "{\"traceLog\":[...],\"executionResult\":3556498,\"stats\":{\"totalEntries\":42,\"executionTimeMs\":85,\"memoryUsedBytes\":1048576,\"truncated\":false}}"
    }]
  }
}
```

### 4. `extract_bytecode`

从页面中提取 JSVMP 字节码数组。

**输入参数（至少指定一个）：**
```json
{
  "scriptUrl": "(optional) string - JS文件URL",
  "selector": "(optional) string - CSS选择器定位script标签",
  "variableName": "(optional) string - 页面全局变量名"
}
```

**输出格式：**
```json
{
  "bytecode": [1, 2, 3, 4, ...],
  "format": "int-array | uint8 | int32 | hex-string | unknown",
  "sourceInfo": {
    "method": "url | selector | variable",
    "source": "https://...",
    "totalArraysFound": 3,
    "selectedArrayLength": 2048
  }
}
```

**使用示例：**
```json
// Request
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "tools/call",
  "params": {
    "name": "extract_bytecode",
    "arguments": {
      "variableName": "window._bytecode"
    }
  }
}

// Response
{
  "jsonrpc": "2.0",
  "id": 4,
  "result": {
    "content": [{
      "type": "text",
      "text": "{\"bytecode\":[12,0,5,3,128,64,...],\"format\":\"uint8\",\"sourceInfo\":{\"method\":\"variable\",\"source\":\"window._bytecode\",\"totalArraysFound\":1,\"selectedArrayLength\":2048}}"
    }]
  }
}
```

### 5. `hook_api`

在当前页面中设置浏览器 API 的隐蔽 Hook。

**输入参数：**
```json
{
  "apiName": "(required) string - API名称，如 fetch/XMLHttpRequest/crypto.subtle.digest",
  "mode": "(required) 'intercept' | 'observe' - Hook模式",
  "options": {
    "captureArgs": "(optional) boolean - 捕获参数，默认true",
    "captureResult": "(optional) boolean - 捕获返回值，默认true",
    "maxLogs": "(optional) integer[10-10000] - 最大日志条数，默认1000"
  }
}
```

**输出格式：**
```json
{
  "hookId": "hook_1719648000_abc123",
  "status": "active",
  "apiName": "fetch",
  "mode": "observe"
}
```

**使用示例：**
```json
// Request
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "tools/call",
  "params": {
    "name": "hook_api",
    "arguments": {
      "apiName": "fetch",
      "mode": "observe",
      "options": { "captureArgs": true, "captureResult": true, "maxLogs": 500 }
    }
  }
}

// Response
{
  "jsonrpc": "2.0",
  "id": 5,
  "result": {
    "content": [{
      "type": "text",
      "text": "{\"hookId\":\"hook_1719648000_x7k2m9\",\"status\":\"active\",\"apiName\":\"fetch\",\"mode\":\"observe\"}"
    }]
  }
}
```

### 6. `get_hook_logs`

获取 Hook 收集到的 API 调用日志。

**输入参数：**
```json
{
  "hookId": "(optional) string - 指定hookId，省略返回所有",
  "filter": {
    "apiName": "(optional) string - 按API名称过滤",
    "timeRange": {
      "start": "(optional) number - 起始时间戳ms",
      "end": "(optional) number - 结束时间戳ms"
    }
  },
  "limit": "(optional) integer[1-5000] - 返回条数，默认100"
}
```

**输出格式：**
```json
{
  "logs": [{
    "hookId": "hook_xxx",
    "apiName": "fetch",
    "timestamp": 1719648001234,
    "args": ["https://api.example.com/sign", { "method": "POST" }],
    "result": { "status": 200 }
  }],
  "totalAvailable": 42,
  "activeHooks": [{ "hookId": "hook_xxx", "apiName": "fetch", "mode": "observe" }]
}
```

**使用示例：**
```json
// Request
{
  "jsonrpc": "2.0",
  "id": 6,
  "method": "tools/call",
  "params": {
    "name": "get_hook_logs",
    "arguments": {
      "hookId": "hook_1719648000_x7k2m9",
      "limit": 50
    }
  }
}

// Response
{
  "jsonrpc": "2.0",
  "id": 6,
  "result": {
    "content": [{
      "type": "text",
      "text": "{\"logs\":[{\"hookId\":\"hook_1719648000_x7k2m9\",\"apiName\":\"fetch\",\"timestamp\":1719648001234,\"args\":[\"https://api.example.com/data\",{\"method\":\"GET\",\"headers\":{\"X-Bogus\":\"DFSz...\"}}],\"result\":{\"status\":200}}],\"totalAvailable\":12,\"activeHooks\":[{\"hookId\":\"hook_1719648000_x7k2m9\",\"apiName\":\"fetch\",\"mode\":\"observe\"}]}"
    }]
  }
}
```

### 7. `page_state`

获取当前活跃标签页的完整状态信息（无参数）。

**输出格式：**
```json
{
  "url": "https://...",
  "title": "Page Title",
  "cookies": [{ "name": "...", "value": "...", "domain": "...", "path": "/", "secure": true, "httpOnly": false }],
  "localStorage": { "key": "value" },
  "sessionStorage": { "key": "value" },
  "scripts": [{ "src": "https://...", "type": null, "isInline": false, "contentLength": 50000, "hasVMPattern": true }],
  "networkRequests": [{ "name": "https://...", "initiatorType": "script", "duration": 120, "transferSize": 4096 }],
  "meta": { "referrer": "never" }
}
```

**使用示例：**
```json
// Request
{ "jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": { "name": "page_state", "arguments": {} } }

// Response
{
  "jsonrpc": "2.0",
  "id": 7,
  "result": {
    "content": [{
      "type": "text",
      "text": "{\"url\":\"https://www.toutiao.com\",\"title\":\"今日头条\",\"cookies\":[...],\"localStorage\":{\"tt_webid\":\"7123456789\"},\"sessionStorage\":{},\"scripts\":[{\"src\":\"https://lf-cdn.toutiao.com/obj/...\",\"type\":null,\"isInline\":false,\"contentLength\":189420,\"hasVMPattern\":true}],\"networkRequests\":[...],\"meta\":{\"referrer\":\"never\"}}"
    }]
  }
}
```

### 8. `deobfuscate`

对混淆的 JavaScript 代码执行反混淆处理。

**输入参数：**
```json
{
  "code": "(required) string - 待反混淆的JS代码",
  "transforms": "(optional) string[] - 指定变换列表，省略则自动检测"
}
```

**可用变换：** `string-array`, `dead-code`, `control-flow`, `rename`, `constant-fold`, `member-expression`, `boolean-simplify`, `hex-numeric`, `unicode-escape`, `comma-expression`

**输出格式：**
```json
{
  "cleanedCode": "// deobfuscated code...",
  "transformsApplied": ["string-array", "control-flow"],
  "confidence": 0.85,
  "stats": {
    "originalLength": 50000,
    "cleanedLength": 12000,
    "reductionPercent": 76,
    "iterationsRun": 3
  }
}
```

**使用示例：**
```json
// Request
{
  "jsonrpc": "2.0",
  "id": 8,
  "method": "tools/call",
  "params": {
    "name": "deobfuscate",
    "arguments": {
      "code": "var _0x4e2f=['log','Hello'];(function(_0x2d8f05){_0x2d8f05[_0x4e2f[0]](_0x4e2f[1]);})(console);",
      "transforms": ["string-array", "member-expression"]
    }
  }
}

// Response
{
  "jsonrpc": "2.0",
  "id": 8,
  "result": {
    "content": [{
      "type": "text",
      "text": "{\"cleanedCode\":\"console.log('Hello');\",\"transformsApplied\":[\"string-array\",\"member-expression\"],\"confidence\":0.9,\"stats\":{\"originalLength\":98,\"cleanedLength\":21,\"reductionPercent\":79,\"iterationsRun\":1}}"
    }]
  }
}
```

---

## 典型工作流

### 工作流1：快速保护检测

```
detect_protection → 根据 type 和 level 选择后续策略
```

```json
// Step 1: Detect
{"method": "tools/call", "params": {"name": "detect_protection", "arguments": {}}}

// Decision tree:
// type=none, level=1       → 无需逆向，直接爬取
// type=obfuscation, level≤3 → deobfuscate → 分析逻辑
// type=jsvmp, level=4       → 进入工作流2
// type=combined, level=5    → 进入工作流2 + WASM分析
```

### 工作流2：JSVMP 算法还原

```
detect_protection → extract_bytecode → analyze_jsvmp → trace_execution → deobfuscate
```

```json
// Step 1: Confirm JSVMP protection
{"method": "tools/call", "params": {"name": "detect_protection", "arguments": {}}}

// Step 2: Extract bytecode array
{"method": "tools/call", "params": {"name": "extract_bytecode", "arguments": {"variableName": "window._bytecode"}}}

// Step 3: Analyze VM structure
{"method": "tools/call", "params": {"name": "analyze_jsvmp", "arguments": {"code": "<vm_code>", "deobfuscate": true}}}

// Step 4: Trace execution with sample input
{"method": "tools/call", "params": {"name": "trace_execution", "arguments": {"code": "<vm_code>", "inputs": {"message": "test_input"}, "maxTraceEntries": 50000}}}

// Step 5: Deobfuscate helper functions
{"method": "tools/call", "params": {"name": "deobfuscate", "arguments": {"code": "<helper_code>"}}}
```

### 工作流3：API 签名逆向

```
hook_api(fetch) → 触发目标操作 → get_hook_logs → analyze_jsvmp(签名函数)
```

```json
// Step 1: Set up fetch hook
{"method": "tools/call", "params": {"name": "hook_api", "arguments": {"apiName": "fetch", "mode": "observe"}}}

// Step 2: (Trigger user action in browser - navigate, click, etc.)
// Wait for API calls to be captured...

// Step 3: Get captured logs
{"method": "tools/call", "params": {"name": "get_hook_logs", "arguments": {"limit": 50}}}

// Step 4: Identify signature parameter (e.g., X-Bogus header)
// Step 5: Locate and analyze the signature function
{"method": "tools/call", "params": {"name": "analyze_jsvmp", "arguments": {"code": "<sign_function_code>"}}}
```

### 工作流4：全流程自动化

完整的端到端逆向分析流程：

```json
// 1. Get page overview
{"method": "tools/call", "params": {"name": "page_state", "arguments": {}}}

// 2. Detect protection type
{"method": "tools/call", "params": {"name": "detect_protection", "arguments": {}}}

// 3. Hook critical APIs
{"method": "tools/call", "params": {"name": "hook_api", "arguments": {"apiName": "fetch", "mode": "observe"}}}
{"method": "tools/call", "params": {"name": "hook_api", "arguments": {"apiName": "crypto.subtle.digest", "mode": "observe"}}}

// 4. (Wait for page activity)

// 5. Collect hook logs and identify signature patterns
{"method": "tools/call", "params": {"name": "get_hook_logs", "arguments": {"limit": 200}}}

// 6. Extract and analyze JSVMP if detected
{"method": "tools/call", "params": {"name": "extract_bytecode", "arguments": {"scriptUrl": "https://lf-cdn.xxx.com/obj/vm.js"}}}
{"method": "tools/call", "params": {"name": "analyze_jsvmp", "arguments": {"code": "...", "deobfuscate": true}}}

// 7. Trace signature generation
{"method": "tools/call", "params": {"name": "trace_execution", "arguments": {"code": "...", "inputs": {"url": "/api/data", "params": "test=1"}}}}

// 8. Final deobfuscation of extracted logic
{"method": "tools/call", "params": {"name": "deobfuscate", "arguments": {"code": "..."}}}
```

---

## 与 web-reverse-engineering-skill 的关系

| 层面 | web-reverse-engineering-skill | WebTrace |
|------|-------------------------------|----------|
| 定位 | 方法论和决策指导（"该做什么"） | 执行能力（"怎么做"） |
| 形式 | Markdown 知识文档 | Chrome Extension + MCP Server |
| 内容 | JSVMP 架构分析、反爬策略、调试技巧 | 自动检测、代码分析、Hook、Trace |
| 使用方 | AI Agent 作为上下文/参考 | AI Agent 通过 MCP 调用 |

**协作模式：**
1. AI Agent 读取 skill 文档确定逆向策略和方向
2. AI Agent 调用 WebTrace MCP 工具执行具体分析步骤
3. 根据 WebTrace 返回的结果，参考 skill 知识做下一步决策

---

## 配置说明

### Extension 加载方式

**开发模式（推荐）：**
```bash
# Build extension
cd /path/to/WebTrace
npm run build

# Launch Chrome with extension
chrome --load-extension=/path/to/WebTrace/dist --disable-extensions-except=/path/to/WebTrace/dist
```

**环境变量：**

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `WEBTRACE_MCP_PORT` | `3100` | WebSocket bridge 监听端口 |
| `WEBTRACE_MCP_HOST` | `127.0.0.1` | WebSocket bridge 绑定地址 |
| `WEBTRACE_LOG_LEVEL` | `info` | 日志级别（debug/info/warn/error） |

### MCP 协议版本

WebTrace 实现 MCP 协议版本 `2024-11-05`，支持以下方法：
- `initialize` — 初始化会话
- `tools/list` — 列出可用工具
- `tools/call` — 调用工具

### 工具执行约束

- **互斥锁：** 同一时间仅一个 Tool 执行（避免浏览器 API 并发冲突）
- **超时：** 每个 Tool 最大执行时间 35 秒
- **重试：** MCP 协议层不内置重试，Agent 可自行实现

---

## 常见问题

### Q: Extension 加载后 MCP Server 没有启动？

Service Worker 可能未被激活。打开 `chrome://extensions` 找到 WebTrace，点击 "Service Worker" 链接查看控制台日志。确认看到 `[WebTrace SW] MCP Server started with RuntimePort transport` 消息。

### Q: WebSocket 连接失败？

Extension Service Worker 无法创建 WebSocket Server。需要一个独立的 bridge 进程。WebTrace 作为 WS client 连接到 bridge，bridge 对外暴露 ws://127.0.0.1:3100/mcp。

### Q: 如何在无头模式下使用？

Chrome Extension 不支持完全无头模式（`--headless`）。使用 `--headless=new` 或虚拟显示（Xvfb）方案：
```bash
xvfb-run chrome --load-extension=/path/to/WebTrace/dist
```

### Q: Tool 执行超时怎么办？

默认超时 35 秒。对于大型代码分析，建议：
1. 先用 `deobfuscate` 缩减代码体积
2. 用 `analyze_jsvmp` 定位关键函数
3. 对提取的关键函数单独 `trace_execution`

### Q: 多 Tab 场景如何工作？

所有需要页面交互的工具（`extract_bytecode`, `hook_api`, `get_hook_logs`, `page_state`）默认操作当前活跃 Tab。如果需要指定 Tab，可通过 `detect_protection` 的 `url` 参数直接分析目标 URL。

### Q: Extension ID 如何固定？

开发模式下，在 `manifest.json` 同目录放置 `key` 字段可固定 Extension ID。生产环境通过 Chrome Web Store 发布后 ID 自动固定。
