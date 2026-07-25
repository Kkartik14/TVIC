import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
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

export type NodeMediaPlaneRequestHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => boolean | Promise<boolean>;

export type NodeMediaPlaneConnectionErrorHandler = (
  error: unknown,
  socket: WebSocket,
) => void | Promise<void>;

export interface NodeMediaPlaneOptions {
  readonly host?: string;
  readonly port: number;
  readonly path: string;
  readonly healthPath?: string;
  readonly onConnection: NodeMediaPlaneConnectionHandler;
  /** Handle non-WebSocket HTTP requests (e.g. the Twilio TwiML webhook). Return true if handled. */
  readonly onRequest?: NodeMediaPlaneRequestHandler;
  /** Routes failures from an async onConnection handler. Defaults to closing the socket. */
  readonly onConnectionError?: NodeMediaPlaneConnectionErrorHandler;
}

export class NodeMediaPlane {
  readonly #options: NodeMediaPlaneOptions;
  readonly #server: Server;
  readonly #wss = new WebSocketServer({ noServer: true });
  #running = false;

  constructor(options: NodeMediaPlaneOptions) {
    this.#options = options;
    this.#server = createServer((request, response) => {
      void this.#dispatchRequest(request, response);
    });

    this.#server.on("upgrade", (request, socket, head) => {
      this.#handleUpgrade(request, socket, head);
    });
  }

  async #dispatchRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (this.#options.onRequest && (await this.#options.onRequest(request, response))) {
        return;
      }

      if (request.url === (this.#options.healthPath ?? "/healthz")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
        return;
      }

      response.writeHead(404);
      response.end();
    } catch {
      if (!response.headersSent) {
        response.writeHead(500);
      }
      response.end();
    }
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
    // A malformed request URL or percent-escape must never reach process-level
    // failure on a public upgrade handler, so reject the socket instead.
    let url: URL;
    let params: Readonly<Record<string, string>> | null;
    try {
      url = new URL(request.url ?? "/", "http://localhost");
      params = matchPath(this.#options.path, url.pathname);
    } catch {
      socket.destroy();
      return;
    }
    if (!params) {
      socket.destroy();
      return;
    }
    const matched = params;

    this.#wss.handleUpgrade(request, socket, head, (ws) => {
      this.#wss.emit("connection", ws, request);
      void this.#runConnection(ws, request, url, matched);
    });
  }

  async #runConnection(
    ws: WebSocket,
    request: IncomingMessage,
    url: URL,
    params: Readonly<Record<string, string>>,
  ): Promise<void> {
    try {
      await this.#options.onConnection({ socket: ws, request, url, params });
    } catch (error) {
      await this.#handleConnectionError(error, ws);
    }
  }

  async #handleConnectionError(error: unknown, ws: WebSocket): Promise<void> {
    // The reusable primitive never lets a handler become an unhandled rejection.
    // Even the error handler is guarded: if it throws/rejects, close the socket.
    const handler = this.#options.onConnectionError;
    if (!handler) {
      ws.close();
      return;
    }
    try {
      await handler(error, ws);
    } catch {
      ws.close();
    }
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
      try {
        params[patternPart.slice(1)] = decodeURIComponent(pathPart);
      } catch {
        return null; // malformed percent-escape
      }
      continue;
    }
    if (patternPart !== pathPart) {
      return null;
    }
  }

  return params;
}
