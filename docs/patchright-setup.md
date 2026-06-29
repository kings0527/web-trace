# 与 patchright 协同使用

patchright 是 Playwright 的反检测分支，提供与 Playwright 兼容的 API 同时绕过浏览器指纹检测。它支持加载 Chrome Extension，可与 WebTrace 协同实现自动化逆向分析。

---

## 安装

### Python 版本

```bash
pip install patchright
patchright install chromium
```

### Node.js 版本

```bash
npm install patchright
npx patchright install chromium
```

要求：
- Python 3.8+ 或 Node.js 18+
- WebTrace Extension 已构建（`npm run build` 后 `dist/` 目录）
- **Extension 需要 headed 模式运行**（`headless=False`）

---

## 配置

### Python 配置

patchright 通过 `persistent_context` 加载 Extension：

```python
from patchright.sync_api import sync_playwright

WEBTRACE_DIST = '/path/to/WebTrace/dist'

with sync_playwright() as p:
    context = p.chromium.launch_persistent_context(
        user_data_dir='./webtrace-profile',  # Browser profile directory
        headless=False,  # Required for extensions
        args=[
            f'--load-extension={WEBTRACE_DIST}',
            f'--disable-extensions-except={WEBTRACE_DIST}',
            '--no-first-run',
        ],
        # Optional: viewport and other settings
        viewport={'width': 1920, 'height': 1080},
        ignore_https_errors=True,
    )
    # ... use context
    context.close()
```

### Node.js 配置

```javascript
const { chromium } = require('patchright');

const WEBTRACE_DIST = '/path/to/WebTrace/dist';

(async () => {
  const context = await chromium.launchPersistentContext('./webtrace-profile', {
    headless: false, // Required for extensions
    args: [
      `--load-extension=${WEBTRACE_DIST}`,
      `--disable-extensions-except=${WEBTRACE_DIST}`,
      '--no-first-run',
    ],
    viewport: { width: 1920, height: 1080 },
    ignoreHTTPSErrors: true,
  });

  // ... use context
  await context.close();
})();
```

---

## 通信方式

### 通过 Service Worker 直接调用

patchright 可以访问 Extension 的 Service Worker（background script），直接在其上下文中调用 MCP 工具：

```python
from patchright.sync_api import sync_playwright
import json
import time

def get_service_worker(context, timeout=10):
    """Wait for WebTrace service worker to be available."""
    start = time.time()
    while time.time() - start < timeout:
        workers = context.service_workers
        for w in workers:
            if 'webtrace' in w.url.lower() or 'chrome-extension://' in w.url:
                return w
        time.sleep(0.5)
    return None
```

### 通过页面上下文调用

与 nodriver 类似，也可以在页面中通过 `chrome.runtime.connect` 与 Extension 通信：

```python
def call_webtrace_tool(page, tool_name: str, arguments: dict = None):
    """Call a WebTrace MCP tool from page context."""
    args_json = json.dumps(arguments or {})
    result = page.evaluate(f'''
        () => new Promise((resolve, reject) => {{
            const port = chrome.runtime.connect(undefined, {{ name: "webtrace-mcp" }});
            port.postMessage({{
                jsonrpc: "2.0", id: 1,
                method: "tools/call",
                params: {{ name: "{tool_name}", arguments: {args_json} }}
            }});
            port.onMessage.addListener((msg) => {{
                resolve(msg);
                port.disconnect();
            }});
            setTimeout(() => {{ reject(new Error("timeout")); port.disconnect(); }}, 40000);
        }})
    ''')
    return result
```

---

## 完整示例

### Python 同步 API 示例

```python
from patchright.sync_api import sync_playwright
import json
import time

WEBTRACE_DIST = '/path/to/WebTrace/dist'

def main():
    with sync_playwright() as p:
        # Launch browser with WebTrace extension
        context = p.chromium.launch_persistent_context(
            user_data_dir='./webtrace-profile',
            headless=False,
            args=[
                f'--load-extension={WEBTRACE_DIST}',
                f'--disable-extensions-except={WEBTRACE_DIST}',
                '--no-first-run',
            ],
            viewport={'width': 1920, 'height': 1080},
        )

        # Navigate to target
        page = context.new_page()
        page.goto('https://www.toutiao.com', wait_until='networkidle')
        page.wait_for_timeout(3000)  # Wait for extension to initialize

        # Step 1: Detect protection
        protection = call_webtrace_tool(page, 'detect_protection')
        print("Protection:", json.dumps(protection, indent=2, ensure_ascii=False))

        # Step 2: Get page state
        state = call_webtrace_tool(page, 'page_state')
        print(f"Page has {len(state.get('scripts', []))} scripts")

        # Step 3: Hook fetch API
        hook = call_webtrace_tool(page, 'hook_api', {
            'apiName': 'fetch',
            'mode': 'observe',
            'options': {'captureArgs': True, 'captureResult': False}
        })
        print("Hook ID:", hook.get('hookId'))

        # Step 4: Trigger page activity
        page.mouse.wheel(0, 500)  # Scroll to trigger lazy-load requests
        page.wait_for_timeout(5000)

        # Step 5: Get hook logs
        logs = call_webtrace_tool(page, 'get_hook_logs', {'limit': 50})
        print(f"Captured {logs.get('totalAvailable', 0)} API calls")

        for log_entry in logs.get('logs', [])[:5]:
            print(f"  [{log_entry['apiName']}] {log_entry.get('args', [''])[0]}")

        context.close()


def call_webtrace_tool(page, tool_name: str, arguments: dict = None):
    """Call WebTrace MCP tool via page evaluate."""
    args_json = json.dumps(arguments or {})
    result = page.evaluate(f'''
        () => new Promise((resolve, reject) => {{
            const port = chrome.runtime.connect(undefined, {{ name: "webtrace-mcp" }});
            port.postMessage({{
                jsonrpc: "2.0", id: 1,
                method: "tools/call",
                params: {{ name: "{tool_name}", arguments: {args_json} }}
            }});
            port.onMessage.addListener((msg) => {{
                if (msg.result && msg.result.content) {{
                    try {{
                        resolve(JSON.parse(msg.result.content[0].text));
                    }} catch {{
                        resolve(msg);
                    }}
                }} else {{
                    resolve(msg);
                }}
                port.disconnect();
            }});
            setTimeout(() => {{ reject(new Error("MCP timeout")); port.disconnect(); }}, 40000);
        }})
    ''')
    return result


if __name__ == '__main__':
    main()
```

### Python 异步 API 示例

```python
from patchright.async_api import async_playwright
import asyncio
import json

WEBTRACE_DIST = '/path/to/WebTrace/dist'

async def main():
    async with async_playwright() as p:
        context = await p.chromium.launch_persistent_context(
            user_data_dir='./webtrace-profile',
            headless=False,
            args=[
                f'--load-extension={WEBTRACE_DIST}',
                f'--disable-extensions-except={WEBTRACE_DIST}',
            ],
        )

        page = await context.new_page()
        await page.goto('https://target-site.com', wait_until='networkidle')
        await page.wait_for_timeout(3000)

        # Full workflow: detect → hook → collect → analyze
        protection = await async_call_tool(page, 'detect_protection')
        print(f"Type: {protection.get('type')}, Level: {protection.get('level')}")

        if protection.get('type') in ('jsvmp', 'combined'):
            # JSVMP detected - extract bytecode
            bytecode = await async_call_tool(page, 'extract_bytecode', {
                'variableName': 'window._bytecode'
            })
            print(f"Bytecode length: {len(bytecode.get('bytecode', []))}")

            # Analyze VM structure
            # First get the VM script content
            state = await async_call_tool(page, 'page_state')
            vm_scripts = [s for s in state.get('scripts', []) if s.get('hasVMPattern')]
            print(f"Found {len(vm_scripts)} scripts with VM patterns")

        await context.close()


async def async_call_tool(page, tool_name: str, arguments: dict = None):
    """Async version of WebTrace MCP tool call."""
    args_json = json.dumps(arguments or {})
    result = await page.evaluate(f'''
        () => new Promise((resolve, reject) => {{
            const port = chrome.runtime.connect(undefined, {{ name: "webtrace-mcp" }});
            port.postMessage({{
                jsonrpc: "2.0", id: 1,
                method: "tools/call",
                params: {{ name: "{tool_name}", arguments: {args_json} }}
            }});
            port.onMessage.addListener((msg) => {{
                if (msg.result && msg.result.content) {{
                    try {{ resolve(JSON.parse(msg.result.content[0].text)); }}
                    catch {{ resolve(msg); }}
                }} else {{ resolve(msg); }}
                port.disconnect();
            }});
            setTimeout(() => {{ reject(new Error("timeout")); port.disconnect(); }}, 40000);
        }})
    ''')
    return result


if __name__ == '__main__':
    asyncio.run(main())
```

### Node.js 示例

```javascript
const { chromium } = require('patchright');

const WEBTRACE_DIST = '/path/to/WebTrace/dist';

async function main() {
  const context = await chromium.launchPersistentContext('./webtrace-profile', {
    headless: false,
    args: [
      `--load-extension=${WEBTRACE_DIST}`,
      `--disable-extensions-except=${WEBTRACE_DIST}`,
    ],
  });

  const page = await context.newPage();
  await page.goto('https://www.toutiao.com', { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);

  // Call WebTrace MCP tool
  const protection = await page.evaluate(() => {
    return new Promise((resolve, reject) => {
      const port = chrome.runtime.connect(undefined, { name: 'webtrace-mcp' });
      port.postMessage({
        jsonrpc: '2.0', id: 1,
        method: 'tools/call',
        params: { name: 'detect_protection', arguments: {} },
      });
      port.onMessage.addListener((msg) => {
        if (msg.result?.content?.[0]?.text) {
          resolve(JSON.parse(msg.result.content[0].text));
        } else {
          resolve(msg);
        }
        port.disconnect();
      });
      setTimeout(() => { reject(new Error('timeout')); port.disconnect(); }, 40000);
    });
  });

  console.log('Protection:', protection);

  // Hook and monitor
  const hook = await page.evaluate(() => {
    return new Promise((resolve) => {
      const port = chrome.runtime.connect(undefined, { name: 'webtrace-mcp' });
      port.postMessage({
        jsonrpc: '2.0', id: 2,
        method: 'tools/call',
        params: {
          name: 'hook_api',
          arguments: { apiName: 'fetch', mode: 'observe' },
        },
      });
      port.onMessage.addListener((msg) => {
        if (msg.result?.content?.[0]?.text) {
          resolve(JSON.parse(msg.result.content[0].text));
        } else {
          resolve(msg);
        }
        port.disconnect();
      });
    });
  });
  console.log('Hook active:', hook.hookId);

  // Trigger network activity
  await page.mouse.wheel(0, 500);
  await page.waitForTimeout(5000);

  // Collect logs
  const logs = await page.evaluate(() => {
    return new Promise((resolve) => {
      const port = chrome.runtime.connect(undefined, { name: 'webtrace-mcp' });
      port.postMessage({
        jsonrpc: '2.0', id: 3,
        method: 'tools/call',
        params: { name: 'get_hook_logs', arguments: { limit: 50 } },
      });
      port.onMessage.addListener((msg) => {
        if (msg.result?.content?.[0]?.text) {
          resolve(JSON.parse(msg.result.content[0].text));
        } else {
          resolve(msg);
        }
        port.disconnect();
      });
    });
  });
  console.log(`Captured ${logs.totalAvailable} requests`);

  await context.close();
}

main().catch(console.error);
```

---

## 注意事项

1. **必须 Headed 模式：** Chrome Extension 在 headless 模式下不会加载。patchright 需要设置 `headless=False`。如需在服务器上运行，使用虚拟显示：
   ```bash
   # Linux server
   xvfb-run python my_script.py
   ```

2. **Persistent Context 必需：** Extension 加载需要 `launch_persistent_context`，普通 `launch` + `new_context` 不支持 Extension。

3. **Profile 目录：** `user_data_dir` 会保存浏览器状态。删除该目录可重置所有状态。

4. **Extension 初始化延迟：** Service Worker 激活需要约 2-3 秒。首次调用 MCP 工具前务必等待足够时间。

5. **patchright vs Playwright：** patchright 的 API 与 Playwright 完全兼容，但增加了反指纹检测能力。如果不需要反检测，也可直接使用 Playwright。

6. **页面导航后 Hook 丢失：** `page.goto()` 或页面内跳转会重置所有 Hook。需要在导航后重新设置。
