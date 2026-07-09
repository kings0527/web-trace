const EXTENSION_NOT_CONNECTED_CODE = -32000;
const EXTENSION_INIT_TIMEOUT_MS = 5_000;
const PROTOCOL_VERSION = '2024-11-05';

const WEBTRACE_TOOLS = [
  tool('detect_protection', '检测指定URL或当前页面的反爬/反调试保护类型和等级。', {
    url: { type: 'string', format: 'uri', description: '待检测的页面URL。省略则分析当前活跃tab的页面。' },
  }),
  tool('analyze_jsvmp', '分析JSVMP代码结构，识别VM派发循环。', {
    code: { type: 'string', minLength: 1, description: 'JSVMP代码字符串。' },
    deobfuscate: { type: 'boolean', default: false },
    chunkSize: { type: 'integer', minimum: 10000, maximum: 5000000 },
    timeout: { type: 'integer', minimum: 5000, maximum: 300000, default: 60000 },
    focusFunction: { type: 'string' },
  }, ['code']),
  tool('trace_execution', '在隔离的QuickJS WASM沙箱中执行JSVMP代码并收集执行trace。', {
    code: { type: 'string', minLength: 1 },
    inputs: { type: 'object', additionalProperties: true },
    maxTraceEntries: { type: 'integer', minimum: 100, maximum: 100000, default: 10000 },
    timeout: { type: 'integer', minimum: 5000, maximum: 300000, default: 60000 },
    chunkSize: { type: 'integer', minimum: 1000, maximum: 5000000 },
  }, ['code']),
  tool('extract_bytecode', '从页面中提取JSVMP字节码数组。', {
    scriptUrl: { type: 'string', format: 'uri' },
    selector: { type: 'string' },
    variableName: { type: 'string' },
  }),
  tool('hook_api', '在当前页面中设置指定浏览器API的Hook。', {
    apiName: { type: 'string', minLength: 1 },
    mode: { type: 'string', enum: ['intercept', 'observe'] },
    options: {
      type: 'object',
      properties: {
        captureArgs: { type: 'boolean', default: true },
        captureResult: { type: 'boolean', default: true },
        captureRequestHeaders: { type: 'boolean', default: false },
        captureResponseHeaders: { type: 'boolean', default: false },
        captureRequestBody: { type: 'boolean', default: false },
        captureResponseBody: { type: 'boolean', default: false },
        maxResponseBodySize: { type: 'integer', minimum: 1024, maximum: 10485760, default: 1048576 },
        maxLogs: { type: 'integer', minimum: 10, maximum: 10000, default: 1000 },
      },
      additionalProperties: false,
    },
  }, ['apiName', 'mode']),
  tool('get_hook_logs', '获取已设置的Hook收集到的API调用日志。', {
    hookId: { type: 'string' },
    filter: {
      type: 'object',
      properties: {
        apiName: { type: 'string' },
        timeRange: {
          type: 'object',
          properties: {
            start: { type: 'number' },
            end: { type: 'number' },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    limit: { type: 'integer', minimum: 1, maximum: 5000, default: 100 },
  }),
  tool('page_state', '获取当前活跃标签页的完整状态信息。', {}),
  tool('deobfuscate', '对混淆的JavaScript代码执行反混淆处理。', {
    code: { type: 'string', minLength: 1 },
    transforms: { type: 'array', items: { type: 'string' } },
  }, ['code']),
  tool('extract_wasm', '从页面或指定URL中提取WASM模块并解析其结构信息。', {
    scriptUrl: { type: 'string', format: 'uri' },
    pageContext: { type: 'boolean', default: true },
  }),
  tool('analyze_wasm', '反汇编和分析WASM模块结构，识别加密算法特征。', {
    wasmBinary: {
      type: 'array',
      items: { type: 'integer', minimum: 0, maximum: 255 },
    },
    moduleIndex: { type: 'integer', minimum: 0 },
    functionName: { type: 'string' },
    disassemble: { type: 'boolean', default: false },
    maxFunctions: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
  }),
  tool('dump_wasm_memory', '读取WASM实例的线性内存指定区域。', {
    offset: { type: 'integer', minimum: 0 },
    length: { type: 'integer', minimum: 1, maximum: 1048576 },
    encoding: { type: 'string', enum: ['hex', 'utf8', 'base64', 'uint8'], default: 'hex' },
    instanceId: { type: 'string' },
  }, ['offset', 'length']),
];

function tool(name, description, properties, required = []) {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties,
      required,
      additionalProperties: false,
    },
  };
}

function isSocketOpen(socket) {
  return Boolean(socket && socket.readyState === socket.OPEN);
}

function hasRequestId(message) {
  return Object.prototype.hasOwnProperty.call(message, 'id') && message.id !== null;
}

function toJsonText(data) {
  if (typeof data === 'string') {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString('utf8');
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data.map((part) => Buffer.from(part))).toString('utf8');
  }
  return Buffer.from(data).toString('utf8');
}

export function createBridgeRouter({
  getExtensionSocket,
  waitForExtensionSocket,
  sendToClient,
  extensionTimeoutMs = 30_000,
  logger = console,
}) {
  const initializedSockets = new WeakSet();
  const initializingSockets = new WeakMap();
  const pendingInternalRequests = new Map();
  let nextInternalRequestId = 1;

  async function resolveExtensionSocket() {
    const socket = getExtensionSocket();
    if (isSocketOpen(socket)) {
      return socket;
    }
    const waitedSocket = await waitForExtensionSocket(extensionTimeoutMs);
    return isSocketOpen(waitedSocket) ? waitedSocket : null;
  }

  async function sendResult(id, result) {
    await sendToClient({ jsonrpc: '2.0', id, result });
  }

  async function sendError(id, message, code = EXTENSION_NOT_CONNECTED_CODE) {
    await sendToClient({
      jsonrpc: '2.0',
      id,
      error: { code, message },
    });
  }

  function initializeExtensionSocket(socket) {
    if (initializedSockets.has(socket)) {
      return Promise.resolve();
    }
    const existing = initializingSockets.get(socket);
    if (existing) {
      return existing;
    }

    const id = `bridge-init-${nextInternalRequestId++}`;
    const promise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingInternalRequests.delete(id);
        reject(new Error('Timed out initializing WebTrace extension MCP server'));
      }, EXTENSION_INIT_TIMEOUT_MS);

      pendingInternalRequests.set(id, {
        resolve: (message) => {
          clearTimeout(timeout);
          if (message.error) {
            reject(new Error(message.error.message ?? 'WebTrace extension initialization failed'));
            return;
          }
          initializedSockets.add(socket);
          socket.send(JSON.stringify({
            jsonrpc: '2.0',
            method: 'notifications/initialized',
            params: {},
          }));
          resolve();
        },
      });
    }).finally(() => {
      initializingSockets.delete(socket);
    });

    initializingSockets.set(socket, promise);
    socket.send(JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: {
          name: 'webtrace-codex-bridge',
          version: '1.0.0',
        },
      },
    }));

    return promise;
  }

  async function handleLocalRequest(message) {
    switch (message.method) {
      case 'initialize':
        await sendResult(message.id, {
          protocolVersion: message.params?.protocolVersion ?? PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'WebTrace Bridge', version: '1.0.0' },
          instructions:
            'WebTrace bridge exposes browser-backed reverse engineering tools. Tool calls require the Edge WebTrace extension to be loaded and connected.',
        });
        return true;
      case 'ping':
        await sendResult(message.id, {});
        return true;
      case 'tools/list':
        await sendResult(message.id, { tools: WEBTRACE_TOOLS });
        return true;
      default:
        return false;
    }
  }

  async function handleClientMessage(message) {
    if (message.method === 'notifications/initialized') {
      return;
    }
    if (hasRequestId(message) && await handleLocalRequest(message)) {
      return;
    }

    const socket = await resolveExtensionSocket();
    if (socket) {
      try {
        await initializeExtensionSocket(socket);
        socket.send(JSON.stringify(message));
      } catch (error) {
        if (hasRequestId(message)) {
          await sendError(
            message.id,
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      return;
    }

    if (hasRequestId(message)) {
      await sendError(
        message.id,
        'WebTrace extension is not connected to the local bridge. Reload the Edge extension and confirm its service worker is active.',
      );
      return;
    }

    logger.warn?.('[WebTrace Bridge] Dropped client notification because no extension is connected');
  }

  async function handleExtensionConnected(socket) {
    try {
      await initializeExtensionSocket(socket);
    } catch (error) {
      logger.warn?.(
        '[WebTrace Bridge] Extension MCP initialization failed:',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async function handleExtensionMessage(data) {
    let message;
    try {
      message = JSON.parse(toJsonText(data));
    } catch (error) {
      logger.warn?.(
        '[WebTrace Bridge] Ignored invalid JSON from extension:',
        error instanceof Error ? error.message : String(error),
      );
      return;
    }

    if (hasRequestId(message) && pendingInternalRequests.has(message.id)) {
      const pending = pendingInternalRequests.get(message.id);
      pendingInternalRequests.delete(message.id);
      pending.resolve(message);
      return;
    }

    await sendToClient(message);
  }

  return {
    handleClientMessage,
    handleExtensionConnected,
    handleExtensionMessage,
  };
}
