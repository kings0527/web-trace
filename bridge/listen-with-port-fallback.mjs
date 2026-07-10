function waitForServerListen(server) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      server.off('listening', onListening);
      server.off('error', onError);
    };
    const onListening = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    server.once('listening', onListening);
    server.once('error', onError);
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

export async function listenWithPortFallback({
  host,
  path,
  startPort,
  portRange,
  createServer,
  logger = console,
}) {
  const errors = [];

  for (let offset = 0; offset < portRange; offset += 1) {
    const port = startPort + offset;
    const server = createServer({ host, port, path });

    try {
      await waitForServerListen(server);
      return { server, port };
    } catch (error) {
      if (error?.code !== 'EADDRINUSE') {
        await closeServer(server);
        throw error;
      }

      errors.push(error);
      await closeServer(server);
      logger.warn?.(`[WebTrace Bridge] Port ${port} is in use, trying ${port + 1}`);
    }
  }

  throw new Error(
    `No available WebTrace bridge port in range ${startPort}-${startPort + portRange - 1}: ${errors.map((error) => error.message).join('; ')}`,
  );
}
