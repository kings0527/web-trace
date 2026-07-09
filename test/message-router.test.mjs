import assert from 'node:assert/strict';
import test from 'node:test';

import { createBridgeRouter } from '../bridge/message-router.mjs';

function createSocket(onSend) {
  const sent = [];
  return {
    readyState: 1,
    OPEN: 1,
    sent,
    send(payload) {
      const message = JSON.parse(payload);
      sent.push(message);
      onSend?.(message);
    },
  };
}

test('responds to MCP initialize without waiting for the extension socket', async () => {
  const clientMessages = [];
  const router = createBridgeRouter({
    getExtensionSocket: () => null,
    waitForExtensionSocket: async () => null,
    sendToClient: async (message) => clientMessages.push(message),
    extensionTimeoutMs: 1,
  });

  await router.handleClientMessage({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'codex-test', version: '0.0.0' },
    },
  });

  assert.equal(clientMessages.length, 1);
  assert.equal(clientMessages[0].jsonrpc, '2.0');
  assert.equal(clientMessages[0].id, 1);
  assert.equal(clientMessages[0].result.protocolVersion, '2024-11-05');
  assert.deepEqual(clientMessages[0].result.capabilities, { tools: { listChanged: true } });
});

test('returns a static tools list without waiting for the extension socket', async () => {
  const clientMessages = [];
  const router = createBridgeRouter({
    getExtensionSocket: () => null,
    waitForExtensionSocket: async () => null,
    sendToClient: async (message) => clientMessages.push(message),
    extensionTimeoutMs: 1,
  });

  await router.handleClientMessage({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {},
  });

  assert.equal(clientMessages.length, 1);
  assert.equal(clientMessages[0].result.tools.some((tool) => tool.name === 'detect_protection'), true);
  assert.equal(clientMessages[0].result.tools.some((tool) => tool.name === 'trace_execution'), true);
});

test('returns a JSON-RPC error when Codex calls a tool before the extension connects', async () => {
  const clientMessages = [];
  const router = createBridgeRouter({
    getExtensionSocket: () => null,
    waitForExtensionSocket: async () => null,
    sendToClient: async (message) => clientMessages.push(message),
    extensionTimeoutMs: 1,
  });

  await router.handleClientMessage({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'page_state', arguments: {} },
  });

  assert.equal(clientMessages.length, 1);
  assert.equal(clientMessages[0].jsonrpc, '2.0');
  assert.equal(clientMessages[0].id, 3);
  assert.equal(clientMessages[0].error.code, -32000);
  assert.match(clientMessages[0].error.message, /WebTrace extension is not connected/);
});

test('initializes the extension server before forwarding tool calls', async () => {
  let router;
  const socket = createSocket((message) => {
    if (message.method === 'initialize') {
      setImmediate(() => {
        router.handleExtensionMessage(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: { name: 'WebTrace', version: '1.0.0' },
            },
          }),
        );
      });
    }
  });
  router = createBridgeRouter({
    getExtensionSocket: () => socket,
    waitForExtensionSocket: async () => socket,
    sendToClient: async () => {},
    extensionTimeoutMs: 10,
  });

  await router.handleExtensionConnected(socket);
  await router.handleClientMessage({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'page_state', arguments: {} },
  });

  assert.equal(socket.sent[0].method, 'initialize');
  assert.equal(socket.sent[1].method, 'notifications/initialized');
  assert.deepEqual(socket.sent[2], {
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'page_state', arguments: {} },
  });
});

test('forwards extension JSON-RPC messages back to the MCP client', async () => {
  const clientMessages = [];
  const router = createBridgeRouter({
    getExtensionSocket: () => null,
    waitForExtensionSocket: async () => null,
    sendToClient: async (message) => clientMessages.push(message),
  });

  await router.handleExtensionMessage(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 5,
      result: { tools: [] },
    }),
  );

  assert.deepEqual(clientMessages, [
    {
      jsonrpc: '2.0',
      id: 5,
      result: { tools: [] },
    },
  ]);
});
