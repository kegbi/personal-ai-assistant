import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { BridgeStatus } from './types';

type StatusProvider = () => BridgeStatus;

export const startHealthServer = (
  port: number,
  statusProvider: StatusProvider,
): Promise<Server> => {
  const server = createServer((req, res) => {
    if (!req.url || req.method !== 'GET') {
      res.statusCode = 404;
      res.end();
      return;
    }

    if (req.url !== '/health') {
      res.statusCode = 404;
      res.end();
      return;
    }

    const status = statusProvider();
    const body = JSON.stringify({
      status: status.ok ? 'ok' : 'degraded',
      uptimeSeconds: Math.round(process.uptime()),
      ...status,
    });

    res.statusCode = status.ok ? 200 : 503;
    res.setHeader('content-type', 'application/json');
    res.end(body);
  });

  return new Promise<Server>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      resolve(server);
    });
  });
};
