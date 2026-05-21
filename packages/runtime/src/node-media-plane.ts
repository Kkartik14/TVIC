import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

import WebSocket, { WebSocketServer } from "ws";

export interface NodeMediaPlaneConnection {
  readonly socket: WebSocket;
  readonly request: IncomingMessage;
  readonly url: URL;
  readonly params: Readonly<Record<string, string>>;
}

export type NodeMediaPlaneConnectionHandler = (
  connection: NodeMediaPlaneConnection,
) => Promise<void> | void;

export interface NodeMediaPlaneOptions {
  readonly host?: string;
  readonly port: number;
  readonly path: string;
  readonly healthPath?: string;
  readonly onConnection: NodeMediaPlaneConnectionHandler;
}

export class NodeMediaPlane {
  readonly #options: NodeMediaPlaneOptions;
  readonly #server: Server;
  readonly #wss = new WebSocketServer({ noServer: true });
  #running = false;

  constructor(options: NodeMediaPlaneOptions) {
    this.#options = options;
    this.#server = createServer((request, response) => {
      if (request.url === (options.healthPath ?? "/healthz")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
        return;
      }

      response.writeHead(404);
      response.end();
    });

    this.#server.on("upgrade", (request, socket, head) => {
      this.#handleUpgrade(request, socket, head);
    });
  }

  get isRunning(): boolean {
    return this.#running;
  }

  get address(): AddressInfo | null {
    const address = this.#server.address();
    return typeof address === "object" ? address : null;
  }

  async start(): Promise<void> {
    if (this.#running) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(this.#options.port, this.#options.host, () => {
        this.#server.off("error", reject);
        this.#running = true;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.#running) {
      return;
    }

    for (const client of this.#wss.clients) {
      client.close();
    }

    await new Promise<void>((resolve, reject) => {
      this.#wss.close((wsError) => {
        if (wsError) {
          reject(wsError);
          return;
        }
        this.#server.close((serverError) => {
          if (serverError) {
            reject(serverError);
            return;
          }
          this.#running = false;
          resolve();
        });
      });
    });
  }

  #handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(request.url ?? "/", "http://localhost");
    const params = matchPath(this.#options.path, url.pathname);
    if (!params) {
      socket.destroy();
      return;
    }

    this.#wss.handleUpgrade(request, socket, head, (ws) => {
      this.#wss.emit("connection", ws, request);
      void this.#options.onConnection({ socket: ws, request, url, params });
    });
  }
}

export function createNodeMediaPlane(options: NodeMediaPlaneOptions): NodeMediaPlane {
  return new NodeMediaPlane(options);
}

export function matchPath(
  pattern: string,
  pathname: string,
): Readonly<Record<string, string>> | null {
  const patternParts = pattern.split("/").filter(Boolean);
  const pathParts = pathname.split("/").filter(Boolean);
  if (patternParts.length !== pathParts.length) {
    return null;
  }

  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i += 1) {
    const patternPart = patternParts[i];
    const pathPart = pathParts[i];
    if (!patternPart || !pathPart) {
      return null;
    }
    if (patternPart.startsWith(":")) {
      params[patternPart.slice(1)] = decodeURIComponent(pathPart);
      continue;
    }
    if (patternPart !== pathPart) {
      return null;
    }
  }

  return params;
}
