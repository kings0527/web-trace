# 与 nodriver 协同使用

nodriver 是一个无第三方依赖的 Python Chrome 自动化库（undetected-chromedriver 的继任者），可启动带有 WebTrace Extension 的浏览器实例，实现自动化逆向分析。

---

## 安装

```bash
pip install nodriver
```

要求：
- Python 3.9+
- 系统已安装 Chrome/Chromium 浏览器
- WebTrace Extension 已构建（`npm run build` 后 `dist/` 目录）

---

## 配置 Extension 路径

nodriver 启动 Chrome 时通过 `browser_args` 加载 WebTrace Extension：

```python
import nodriver as uc

async def launch_with_webtrace():
    # WebTrace extension build output directory
    WEBTRACE_DIST = '/path/to/WebTrace/dist'

    browser = await uc.start(
        browser_args=[
            f'--load-extension={WEBTRACE_DIST}',
            f'--disable-extensions-except={WEBTRACE_DIST}',
            # Optional: disable first-run UI
            '--no-first-run',
            '--no-default-browser-check',
        ]
    )
    return browser
```

> **注意：** `--load-extension` 和 `--disable-extensions-except` 需要指向 Extension 的 `dist/` 构建输出目录（包含 `manifest.json` 的目录），而非源码目录。

---

## 通信方式

### 方式 A：通过 CDP 在页面内执行（简单直接）

nodriver 基于 CDP 协议，可直接在页面上下文执行 JavaScript 与 WebTrace 的 MCP Server 交互：

```python
import nodriver as uc
import asyncio
import json

async def call_mcp_tool(page, tool_name: str, arguments: dict = None):
    """
    Through page evaluate, connect to WebTrace extension and call MCP tool.
    """
    args_json = json.dumps(arguments or {})
    tool_json = json.dumps(tool_name)

    result = await page.evaluate(f'''
        new Promise((resolve, reject) => {{
            try {{
                const port = chrome.runtime.connect(
                    undefined,  // Same extension context
                    {{ name: "webtrace-mcp" }}
                );
                port.postMessage({{
                    jsonrpc: "2.0",
                    id: 1,
                    method: "tools/call",
                    params: {{ name: {tool_json}, arguments: {args_json} }}
                }});
                port.onMessage.addListener((msg) => {{
                    resolve(JSON.stringify(msg));
                    port.disconnect();
                }});
                setTimeout(() => {{
                    reject(new Error("MCP call timeout"));
                    port.disconnect();
                }}, 40000);
            }} catch(e) {{
                reject(e);
            }}
        }});
    ''')
    return json.loads(result) if result else None
```

### 方式 B：通过 WebSocket Bridge（推荐用于复杂自动化）

如果需要从 Python 进程直接调用 MCP 工具（不依赖页面上下文），可启动一个 WebSocket bridge：

```python
import asyncio
import websockets
import json

class WebTraceMCPClient:
    """WebTrace MCP client via WebSocket bridge."""

    def __init__(self, port: int = 3100):
        self.uri = f"ws://127.0.0.1:{port}/mcp"
        self.ws = None
        self._id_counter = 0

    async def connect(self):
        self.ws = await websockets.connect(self.uri)
        # Initialize MCP session
        await self._send("initialize", {
            "protocolVersion": "2024-11-05",
            "clientInfo": {"name": "nodriver-agent", "version": "1.0.0"},
            "capabilities": {}
        })
        response = await self._recv()
        return response

    async def call_tool(self, name: str, arguments: dict = None) -> dict:
        """Call a WebTrace MCP tool."""
        result = await self._send("tools/call", {
            "name": name,
            "arguments": arguments or {}
        })
        return await self._recv()

    async def list_tools(self) -> dict:
        """List all available tools."""
        await self._send("tools/list", {})
        return await self._recv()

    async def close(self):
        if self.ws:
            await self.ws.close()

    async def _send(self, method: str, params: dict):
        self._id_counter += 1
        msg = {
            "jsonrpc": "2.0",
            "id": self._id_counter,
            "method": method,
            "params": params
        }
        await self.ws.send(json.dumps(msg))

    async def _recv(self) -> dict:
        data = await self.ws.recv()
        return json.loads(data)
```

---

## 完整示例

### 示例1：检测页面保护类型

```python
import nodriver as uc
import asyncio
import json

WEBTRACE_DIST = '/path/to/WebTrace/dist'

async def detect_protection_example():
    # Launch Chrome with WebTrace
    browser = await uc.start(
        browser_args=[
            f'--load-extension={WEBTRACE_DIST}',
            f'--disable-extensions-except={WEBTRACE_DIST}',
        ]
    )

    # Navigate to target
    page = await browser.get('https://www.toutiao.com')
    await page.sleep(5)  # Wait for page and extension to fully load

    # Call detect_protection via page context
    result = await page.evaluate('''
        new Promise((resolve) => {
            const port = chrome.runtime.connect(undefined, { name: "webtrace-mcp" });
            port.postMessage({
                jsonrpc: "2.0", id: 1,
                method: "tools/call",
                params: { name: "detect_protection", arguments: {} }
            });
            port.onMessage.addListener((msg) => {
                resolve(JSON.stringify(msg));
                port.disconnect();
            });
        });
    ''')

    protection = json.loads(result)
    print(f"Protection type: {protection}")

    # Decide next steps based on protection level
    data = json.loads(protection.get('result', {}).get('content', [{}])[0].get('text', '{}'))
    if data.get('type') == 'jsvmp':
        print("JSVMP detected! Proceeding with bytecode extraction...")
        # ... continue with extract_bytecode, analyze_jsvmp, etc.

    await browser.close()

if __name__ == '__main__':
    asyncio.run(detect_protection_example())
```

### 示例2：全自动 API 签名分析

```python
import nodriver as uc
import asyncio
import json
import time

WEBTRACE_DIST = '/path/to/WebTrace/dist'

async def api_signature_analysis():
    browser = await uc.start(
        browser_args=[
            f'--load-extension={WEBTRACE_DIST}',
            f'--disable-extensions-except={WEBTRACE_DIST}',
        ]
    )

    page = await browser.get('https://www.toutiao.com')
    await page.sleep(3)

    # Step 1: Set up fetch hook
    hook_result = await page.evaluate('''
        new Promise((resolve) => {
            const port = chrome.runtime.connect(undefined, { name: "webtrace-mcp" });
            port.postMessage({
                jsonrpc: "2.0", id: 1,
                method: "tools/call",
                params: {
                    name: "hook_api",
                    arguments: {
                        apiName: "fetch",
                        mode: "observe",
                        options: { captureArgs: true, captureResult: false, maxLogs: 200 }
                    }
                }
            });
            port.onMessage.addListener((msg) => { resolve(JSON.stringify(msg)); port.disconnect(); });
        });
    ''')
    print("Hook set:", hook_result)

    # Step 2: Trigger page actions (scroll, click, etc.)
    await page.scroll_down(300)
    await page.sleep(5)

    # Step 3: Collect hook logs
    logs_result = await page.evaluate('''
        new Promise((resolve) => {
            const port = chrome.runtime.connect(undefined, { name: "webtrace-mcp" });
            port.postMessage({
                jsonrpc: "2.0", id: 2,
                method: "tools/call",
                params: { name: "get_hook_logs", arguments: { limit: 100 } }
            });
            port.onMessage.addListener((msg) => { resolve(JSON.stringify(msg)); port.disconnect(); });
        });
    ''')
    logs = json.loads(logs_result)
    print(f"Captured {len(logs.get('result', {}).get('content', [{}]))} log entries")

    # Step 4: Analyze captured requests for signature patterns
    # ... further analysis logic

    await browser.close()

if __name__ == '__main__':
    asyncio.run(api_signature_analysis())
```

### 示例3：与 WebSocket Bridge 配合使用

```python
import nodriver as uc
import asyncio
import json
import websockets

WEBTRACE_DIST = '/path/to/WebTrace/dist'
MCP_PORT = 3100

async def websocket_bridge_example():
    # Step 1: Launch browser with extension
    browser = await uc.start(
        browser_args=[
            f'--load-extension={WEBTRACE_DIST}',
            f'--disable-extensions-except={WEBTRACE_DIST}',
        ]
    )

    # Step 2: Navigate to target
    page = await browser.get('https://target-site.com')
    await page.sleep(3)

    # Step 3: Connect to MCP via WebSocket bridge
    # (Requires bridge process running: node bridge.js --port 3100)
    try:
        async with websockets.connect(f"ws://127.0.0.1:{MCP_PORT}/mcp") as ws:
            # Initialize
            await ws.send(json.dumps({
                "jsonrpc": "2.0", "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2024-11-05",
                    "clientInfo": {"name": "nodriver-ws", "version": "1.0.0"},
                    "capabilities": {}
                }
            }))
            init_resp = json.loads(await ws.recv())
            print("MCP initialized:", init_resp)

            # Call page_state
            await ws.send(json.dumps({
                "jsonrpc": "2.0", "id": 2,
                "method": "tools/call",
                "params": {"name": "page_state", "arguments": {}}
            }))
            state = json.loads(await ws.recv())
            print("Page state:", json.dumps(state, indent=2, ensure_ascii=False)[:500])

    except Exception as e:
        print(f"WebSocket bridge not available: {e}")
        print("Falling back to CDP-based communication...")

    await browser.close()

if __name__ == '__main__':
    asyncio.run(websocket_bridge_example())
```

---

## 注意事项

1. **Extension 加载时机：** Extension 的 Service Worker 在浏览器启动后约 1-2 秒内激活。建议在 `page.sleep(3)` 后再进行 MCP 调用。

2. **页面导航重置：** 页面导航（跳转、刷新）后，已设置的 Hook 会丢失。需要重新调用 `hook_api`。

3. **nodriver 反检测：** nodriver 本身带有反检测能力，与 WebTrace 的 stealth 引擎互补。无需额外配置。

4. **多 Tab 管理：** `page_state`、`hook_api`、`extract_bytecode` 等工具默认操作活跃 Tab。在多 Tab 场景下，确保目标 Tab 为活跃状态。

5. **构建路径：** 始终使用构建后的 `dist/` 目录，而非源码 `src/` 目录。每次修改代码后需重新 `npm run build`。
