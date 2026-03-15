/**
 * Lightweight HTTP + WebSocket reverse proxy for dev-runner.
 *
 * Vite always proxies /api and /ws to a fixed "bridge" port.
 * This proxy forwards:
 *   - HTTP requests → apiUpstream (server.ts, always 8765)
 *   - WebSocket upgrades → wsUpstream (switchable: 8765 or 8766)
 */

import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { createConnection, type Socket } from 'node:net';

export class DevProxy {
  private server: Server;
  private apiUpstream: number;
  private wsUpstream: number;
  private proxyPort: number;

  constructor(proxyPort: number, apiUpstream: number, wsUpstream: number) {
    this.proxyPort = proxyPort;
    this.apiUpstream = apiUpstream;
    this.wsUpstream = wsUpstream;

    this.server = createServer((req, res) => this.handleRequest(req, res));
    this.server.on('upgrade', (req, socket, head) =>
      this.handleUpgrade(req, socket as Socket, head),
    );
  }

  setWsUpstream(port: number) {
    this.wsUpstream = port;
  }

  getWsUpstream() {
    return this.wsUpstream;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.proxyPort, '127.0.0.1', () => {
        this.server.removeListener('error', reject);
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  // ── HTTP (for /api/*) ──

  private handleRequest(req: IncomingMessage, res: ServerResponse) {
    const proxyReq = httpRequest(
      {
        hostname: '127.0.0.1',
        port: this.apiUpstream,
        path: req.url,
        method: req.method,
        headers: req.headers,
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode!, proxyRes.headers);
        proxyRes.pipe(res);
      },
    );
    proxyReq.on('error', () => {
      if (!res.headersSent) res.writeHead(502).end('Bad Gateway');
    });
    req.pipe(proxyReq);
  }

  // ── WebSocket upgrade (for /ws/*) ──

  private handleUpgrade(req: IncomingMessage, clientSocket: Socket, head: Buffer) {
    const upstream = createConnection(
      { port: this.wsUpstream, host: '127.0.0.1' },
      () => {
        // Reconstruct the HTTP upgrade request to the upstream server
        let rawHeader = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
        const headers = req.rawHeaders;
        for (let i = 0; i < headers.length; i += 2) {
          rawHeader += `${headers[i]}: ${headers[i + 1]}\r\n`;
        }
        rawHeader += '\r\n';

        upstream.write(rawHeader);
        if (head.length) upstream.write(head);

        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      },
    );

    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  }
}
