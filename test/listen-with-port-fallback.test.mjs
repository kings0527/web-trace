import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { listenWithPortFallback } from '../bridge/listen-with-port-fallback.mjs';

class FakeServer extends EventEmitter {
  constructor(port, outcome) {
    super();
    this.port = port;
    this.closed = false;
    queueMicrotask(() => {
      if (outcome === 'listen') {
        this.emit('listening');
        return;
      }
      const error = new Error(outcome);
      error.code = outcome;
      this.emit('error', error);
    });
  }

  close(callback) {
    this.closed = true;
    callback?.();
  }
}

test('falls back to the next port when the first port is already in use', async () => {
  const attemptedPorts = [];
  const result = await listenWithPortFallback({
    host: '127.0.0.1',
    path: '/mcp',
    startPort: 3100,
    portRange: 3,
    createServer: ({ port }) => {
      attemptedPorts.push(port);
      return new FakeServer(port, port === 3100 ? 'EADDRINUSE' : 'listen');
    },
    logger: { warn() {}, error() {} },
  });

  assert.deepEqual(attemptedPorts, [3100, 3101]);
  assert.equal(result.port, 3101);
  assert.equal(result.server.port, 3101);
});

test('throws when every port in the range is already in use', async () => {
  await assert.rejects(
    listenWithPortFallback({
      host: '127.0.0.1',
      path: '/mcp',
      startPort: 3100,
      portRange: 2,
      createServer: ({ port }) => new FakeServer(port, 'EADDRINUSE'),
      logger: { warn() {}, error() {} },
    }),
    /No available WebTrace bridge port/,
  );
});

test('does not hide non-port-conflict listen errors', async () => {
  await assert.rejects(
    listenWithPortFallback({
      host: '127.0.0.1',
      path: '/mcp',
      startPort: 3100,
      portRange: 2,
      createServer: ({ port }) => new FakeServer(port, 'EACCES'),
      logger: { warn() {}, error() {} },
    }),
    /EACCES/,
  );
});
