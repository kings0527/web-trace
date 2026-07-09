# WebTrace

> AI-driven JSVMP Auto-Reversal Chrome/Edge Extension with MCP Server

## Features

- **MCP Server**: Expose reverse engineering capabilities via MCP protocol for AI Agents
- **JSVMP Auto-Detection**: Automatically identify VM dispatch loops (while-switch/if-else/handler-table)
- **QuickJS WASM Sandbox**: Execute and trace JSVMP bytecode in isolated environment
- **Stealth Engine**: Three-layer stealth (Extension hiding + Proxy Hook cloaking + Timing alignment)
- **Babel AST Instrumentation**: Auto-instrument VM dispatch loops for trace collection
- **Cross-browser**: Chrome & Edge (Manifest V3)

## Quick Start

### Build
```bash
npm install
npm run build
```

### Load Extension
1. Open `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked" → select `dist/` directory

### Connect AI Agent
See [docs/SKILL-INTEGRATION.md](docs/SKILL-INTEGRATION.md)

### Connect Codex CLI

WebTrace now includes a local stdio bridge for MCP clients that cannot connect to
an Edge extension RuntimePort directly. The bridge listens for the extension at
`ws://127.0.0.1:3100/mcp` and proxies MCP JSON-RPC over stdio to Codex.

```bash
codex mcp add webtrace -- node /Users/kk/git/web-trace/bin/webtrace-codex-bridge.mjs
```

After changing extension code, rebuild and reload the unpacked extension in
`edge://extensions`. The extension service worker automatically connects to the
bridge when Codex starts it.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                   AI Agent (MCP Client)              │
│            Qoder / Cursor / Claude Code             │
└────────────────────┬────────────────────────────────┘
                     │ MCP Protocol (WebSocket/Port)
┌────────────────────▼────────────────────────────────┐
│              Service Worker (Background)              │
│  ┌─────────┐  ┌──────────┐  ┌──────────────────┐   │
│  │MCP Server│  │Tab Manager│  │Offscreen Manager │   │
│  └─────────┘  └──────────┘  └────────┬─────────┘   │
└───────────────────────────────────────┼─────────────┘
                                        │
┌───────────────────────────────────────▼─────────────┐
│              Offscreen Document                       │
│  ┌──────────────────┐  ┌─────────────────────────┐  │
│  │QuickJS WASM      │  │Babel AST Engine         │  │
│  │(Sandbox + Trace) │  │(Detect + Instrument)    │  │
│  └──────────────────┘  └─────────────────────────┘  │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│              Target Web Page                          │
│  ┌────────────┐  ┌────────────┐  ┌──────────────┐  │
│  │Stealth     │  │VM Tracer   │  │API Hooks     │  │
│  │Bootstrap   │  │(Proxy)     │  │(fetch/XHR)   │  │
│  └────────────┘  └────────────┘  └──────────────┘  │
└─────────────────────────────────────────────────────┘
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `detect_protection` | Detect page protection type and level |
| `analyze_jsvmp` | Analyze JSVMP code structure |
| `trace_execution` | Execute in sandbox with full trace |
| `extract_bytecode` | Extract bytecode arrays from page |
| `hook_api` | Set up API hooks on page |
| `get_hook_logs` | Retrieve hook logs |
| `page_state` | Get page state (cookies/storage/scripts) |
| `deobfuscate` | Deobfuscate JS code |

## Integration

- [AI Agent Integration Guide](docs/SKILL-INTEGRATION.md)
- [nodriver Setup](docs/nodriver-setup.md)
- [patchright Setup](docs/patchright-setup.md)

## Tech Stack

- TypeScript + Vite
- Chrome Extension Manifest V3
- MCP (Model Context Protocol)
- QuickJS WASM (quickjs-emscripten)
- Babel AST (@babel/parser + traverse)

## License

MIT
