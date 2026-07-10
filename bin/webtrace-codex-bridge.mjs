#!/usr/bin/env node

import process from 'node:process';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WebSocketServer } from 'ws';

import { createBridgeRouter } from '../bridge/message-router.mjs';
import { listenWithPortFallback } from '../bridge/listen-with-port-fallback.mjs';

function readOption(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index !== -1 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }
  return fallback;
}

const host = readOption('host', process.env.WEBTRACE_MCP_HOST ?? '127.0.0.1');
const port = Number(readOption('port', process.env.WEBTRACE_MCP_PORT ?? '3100'));
const path = readOption('path', process.env.WEBTRACE_MCP_PATH ?? '/mcp');
const portRange = Number(readOption('port-range', process.env.WEBTRACE_MCP_PORT_RANGE ?? '10'));
const extensionTimeoutMs = Number(
  readOption('extension-timeout-ms', process.env.WEBTRACE_EXTENSION_TIMEOUT_MS ?? '30000'),
);

let extensionSocket = null;
const waiters = new Set();

function isSocketOpen(socket) {
  return Boolean(socket && socket.readyState === socket.OPEN);
}

function getExtensionSocket() {
  return isSocketOpen(extensionSocket) ? extensionSocket : null;
}

function waitForExtensionSocket(timeoutMs) {
  const socket = getExtensionSocket();
  if (socket) {
    return Promise.resolve(socket);
  }

  return new Promise((resolve) => {
    const waiter = (connectedSocket) => {
      clearTimeout(timeout);
      waiters.delete(waiter);
      resolve(connectedSocket);
    };
    const timeout = setTimeout(() => {
      waiters.delete(waiter);
      resolve(null);
    }, timeoutMs);
    waiters.add(waiter);
  });
}

function setExtensionSocket(socket) {
  if (isSocketOpen(extensionSocket) && extensionSocket !== socket) {
    extensionSocket.close(1012, 'Replaced by a newer WebTrace extension connection');
  }

  extensionSocket = socket;
  for (const waiter of [...waiters]) {
    waiter(socket);
  }
}

const stdio = new StdioServerTransport();
const router = createBridgeRouter({
  getExtensionSocket,
  waitForExtensionSocket,
  sendToClient: (message) => stdio.send(message),
  extensionTimeoutMs,
  logger: console,
});

const { server: wss, port: listeningPort } = await listenWithPortFallback({
  host,
  path,
  startPort: port,
  portRange,
  createServer: (options) => new WebSocketServer(options),
  logger: console,
});
console.error(`[WebTrace Bridge] Listening for Edge extension at ws://${host}:${listeningPort}${path}`);

stdio.onmessage = (message) => {
  router.handleClientMessage(message).catch((error) => {
    console.error('[WebTrace Bridge] Failed to handle MCP client message:', error);
  });
};
stdio.onerror = (error) => {
  console.error('[WebTrace Bridge] stdio error:', error);
};
stdio.onclose = () => {
  wss.close();
};

wss.on('connection', (socket, request) => {
  setExtensionSocket(socket);
  console.error(
    `[WebTrace Bridge] Extension connected from ${request.socket.remoteAddress ?? 'unknown'}`,
  );
  router.handleExtensionConnected(socket).catch((error) => {
    console.error('[WebTrace Bridge] Failed to initialize extension MCP server:', error);
  });

  socket.on('message', (data) => {
    router.handleExtensionMessage(data).catch((error) => {
      console.error('[WebTrace Bridge] Failed to handle extension message:', error);
    });
  });

  socket.on('close', () => {
    if (extensionSocket === socket) {
      extensionSocket = null;
    }
    console.error('[WebTrace Bridge] Extension disconnected');
  });

  socket.on('error', (error) => {
    console.error('[WebTrace Bridge] extension socket error:', error);
  });
});

wss.on('error', (error) => {
  console.error('[WebTrace Bridge] WebSocket server error:', error);
  process.exitCode = 1;
});

await stdio.start();

process.on('SIGINT', async () => {
  wss.close();
  await stdio.close();
  process.exit(130);
});

process.on('SIGTERM', async () => {
  wss.close();
  await stdio.close();
  process.exit(143);
});
