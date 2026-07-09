import assert from 'node:assert/strict';
import test from 'node:test';

import { createBridgeRouter } from '../bridge/message-router.mjs';

function createSocket() {
  const sent = [];
  return {
    readyState: 1,
    OPEN: 1,
    sent,
    send(payload) {
      sent.push(JSON.parse(payload));
    },
  };
}

test('forwards client JSON-RPC messages to the connected extension socket', async () => {
  const socket = createSocket();
  const router = createBridgeRouter({
    getExtensionSocket: () => socket,
    waitForExtensionSocket: async () => socket,
    sendToClient: async () => {},
    extensionTimeoutMs: 10,
  });

  await router.handleClientMessage({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
    params: {},
  });

  assert.deepEqual(socket.sent, [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    },
  ]);
});

test('returns a JSON-RPC error when Codex calls before the extension connects', async () => {
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
    method: 'initialize',
    params: {},
  });

  assert.equal(clientMessages.length, 1);
  assert.equal(clientMessages[0].jsonrpc, '2.0');
  assert.equal(clientMessages[0].id, 2);
  assert.equal(clientMessages[0].error.code, -32000);
  assert.match(clientMessages[0].error.message, /WebTrace extension is not connected/);
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
      id: 3,
      result: { tools: [] },
    }),
  );

  assert.deepEqual(clientMessages, [
    {
      jsonrpc: '2.0',
      id: 3,
      result: { tools: [] },
    },
  ]);
});
