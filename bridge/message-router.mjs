const EXTENSION_NOT_CONNECTED_CODE = -32000;

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
  async function resolveExtensionSocket() {
    const socket = getExtensionSocket();
    if (isSocketOpen(socket)) {
      return socket;
    }
    const waitedSocket = await waitForExtensionSocket(extensionTimeoutMs);
    return isSocketOpen(waitedSocket) ? waitedSocket : null;
  }

  async function handleClientMessage(message) {
    const socket = await resolveExtensionSocket();
    if (socket) {
      socket.send(JSON.stringify(message));
      return;
    }

    if (hasRequestId(message)) {
      await sendToClient({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: EXTENSION_NOT_CONNECTED_CODE,
          message:
            'WebTrace extension is not connected to the local bridge. Reload the Edge extension and confirm its service worker is active.',
        },
      });
      return;
    }

    logger.warn?.('[WebTrace Bridge] Dropped client notification because no extension is connected');
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

    await sendToClient(message);
  }

  return {
    handleClientMessage,
    handleExtensionMessage,
  };
}
