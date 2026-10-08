import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { performance } from "node:perf_hooks";
import type { Duplex } from "node:stream";

import WebSocket, { WebSocketServer } from "ws";

const DEFAULT_MAX_INBOUND_FRAME_FRAGMENTS = 128;
const MAX_CONFIGURED_INBOUND_FRAME_FRAGMENTS = 16_384;
const MAX_CONFIGURED_INBOUND_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_INBOUND_CONTROL_FRAMES_PER_WINDOW = 10;
const INBOUND_CONTROL_FRAME_WINDOW_MS = 1_000;

export type UpgradeAuthorization<TContext> =
  | { readonly ok: true; readonly context: TContext }
  | { readonly ok: false; readonly statusCode: number; readonly reason?: string };

export interface NodeMediaPlaneConnection<TContext = unknown> {
  readonly socket: WebSocket;
  readonly request: IncomingMessage;
  readonly url: URL;
  readonly params: Readonly<Record<string, string>>;
  readonly upgradeContext?: TContext;
}

export type NodeMediaPlaneConnectionHandler<TContext = unknown> = (
  connection: NodeMediaPlaneConnection<TContext>,
) => Promise<void> | void;

export type NodeMediaPlaneRequestHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  signal: AbortSignal,
) => boolean | Promise<boolean>;

export type NodeMediaPlaneConnectionErrorHandler = (
  error: unknown,
  socket: WebSocket,
) => void | Promise<void>;

export interface NodeMediaPlaneOptions<TContext = unknown> {
  readonly host?: string;
  readonly port: number;
  readonly path: string;
  /** Maximum payload bytes accepted for an inbound WebSocket message. Maximum: 16 MiB. */
  readonly maxInboundFrameBytes?: number;
  /** Maximum fragments in one inbound WebSocket message. Default: 128; maximum: 16384. */
  readonly maxInboundFrameFragments?: number;
  /** Maximum time to wait for connected peers to finish the WebSocket close handshake. Default: 5000 ms. */
  readonly webSocketCloseTimeoutMs?: number;
  readonly healthPath?: string;
  /**
   * Optional health check. Called when the plane's `healthPath` endpoint
   * is hit. The plane responds 200 with `{ ok: true }` if the check
   * returns `ok: true`, and 503 with `{ ok: false }` otherwise. Check
   * details stay inside the host process and are never serialized by this
   * endpoint. The signal aborts when the request disconnects or the plane
   * begins stopping. This is where the runtime's `RuntimeOptions.healthCheck`
   * plugs in so the load balancer can drain traffic before a replica's
   * Postgres becomes unreachable. See `docs/operations/multi-replica.md`.
   */
  readonly healthCheck?: (signal: AbortSignal) => Promise<{
    readonly ok: boolean;
    readonly checks?: Readonly<Record<string, unknown>>;
  }>;
  readonly onConnection: NodeMediaPlaneConnectionHandler<TContext>;
  /**
   * Handle non-WebSocket HTTP requests (e.g. the Twilio TwiML webhook). Return
   * true if handled. The signal aborts when the client disconnects or the plane
   * begins stopping; handlers should stop side effects when it is aborted.
   */
  readonly onRequest?: NodeMediaPlaneRequestHandler;
  /** Routes failures from an async onConnection handler. Defaults to closing the socket. */
  readonly onConnectionError?: NodeMediaPlaneConnectionErrorHandler;
  /**
   * Pre-handshake authorization. Async checks are bounded by
   * `authorizationTimeoutMs`; the signal aborts when the client disconnects
   * or the check times out. Throwing rejects with HTTP 500.
   */
  readonly authorizeUpgrade?: (
    request: IncomingMessage,
    url: URL,
    params: Readonly<Record<string, string>>,
    signal: AbortSignal,
  ) => UpgradeAuthorization<TContext> | PromiseLike<UpgradeAuthorization<TContext>>;
  /** Maximum time for pre-handshake authorization. Default: 250 ms. */
  readonly authorizationTimeoutMs?: number;
  /** Maximum concurrent pre-handshake authorization checks. Default: 128. */
  readonly maxPendingAuthorizations?: number;
  /**
   * Releases state reserved by a successful authorization if the handshake aborts.
   * This best-effort callback is not awaited; failures go to
   * `onUpgradeAbortedError`.
   */
  readonly onUpgradeAborted?: (context: TContext) => void | PromiseLike<void>;
  /** Reports a failed best-effort `onUpgradeAborted` callback. */
  readonly onUpgradeAbortedError?: (error: unknown, context: TContext) => void | PromiseLike<void>;
}

export class NodeMediaPlane<TContext = unknown> {
  readonly #options: NodeMediaPlaneOptions<TContext>;
  readonly #server: Server;
  readonly #maxInboundFrameBytes: number;
  readonly #maxInboundFrameFragments: number;
  readonly #webSocketCloseTimeoutMs: number;
  #wss: WebSocketServer;
  readonly #authorizationTimeoutMs: number;
  readonly #maxPendingAuthorizations: number;
  readonly #pendingUpgradeSockets = new Set<Duplex>();
  readonly #pendingAuthorizationControllers = new Set<AbortController>();
  readonly #activeHttpRequestControllers = new Set<AbortController>();
  #startPromise: Promise<void> | undefined;
  #stopPromise: Promise<void> | undefined;
  #pendingAuthorizations = 0;
  #running = false;
  #stopping = false;
  #webSocketServerClosed = false;

  constructor(options: NodeMediaPlaneOptions<TContext>) {
    this.#options = options;
    this.#authorizationTimeoutMs = options.authorizationTimeoutMs ?? 250;
    this.#maxPendingAuthorizations = options.maxPendingAuthorizations ?? 128;
    if (
      !Number.isSafeInteger(this.#authorizationTimeoutMs) ||
      this.#authorizationTimeoutMs < 1 ||
      this.#authorizationTimeoutMs > 60_000
    ) {
      throw new Error("authorizationTimeoutMs must be an integer from 1 to 60000");
    }
    if (
      !Number.isSafeInteger(this.#maxPendingAuthorizations) ||
      this.#maxPendingAuthorizations < 1 ||
      this.#maxPendingAuthorizations > 10_000
    ) {
      throw new Error("maxPendingAuthorizations must be an integer from 1 to 10000");
    }
    this.#maxInboundFrameBytes = options.maxInboundFrameBytes ?? 1_048_576;
    if (
      !Number.isSafeInteger(this.#maxInboundFrameBytes) ||
      this.#maxInboundFrameBytes < 1 ||
      this.#maxInboundFrameBytes > MAX_CONFIGURED_INBOUND_FRAME_BYTES
    ) {
      throw new Error("maxInboundFrameBytes must be an integer from 1 to 16777216");
    }
    this.#maxInboundFrameFragments =
      options.maxInboundFrameFragments ?? DEFAULT_MAX_INBOUND_FRAME_FRAGMENTS;
    if (
      !Number.isSafeInteger(this.#maxInboundFrameFragments) ||
      this.#maxInboundFrameFragments < 1 ||
      this.#maxInboundFrameFragments > MAX_CONFIGURED_INBOUND_FRAME_FRAGMENTS
    ) {
      throw new Error("maxInboundFrameFragments must be an integer from 1 to 16384");
    }
    this.#webSocketCloseTimeoutMs = options.webSocketCloseTimeoutMs ?? 5_000;
    if (
      !Number.isSafeInteger(this.#webSocketCloseTimeoutMs) ||
      this.#webSocketCloseTimeoutMs < 1 ||
      this.#webSocketCloseTimeoutMs > 60_000
    ) {
      throw new Error("webSocketCloseTimeoutMs must be an integer from 1 to 60000");
    }
    this.#wss = this.#createWebSocketServer();
    this.#server = createServer((request, response) => {
      void this.#dispatchRequest(request, response);
    });

    this.#server.on("upgrade", (request, socket, head) => {
      this.#pendingUpgradeSockets.add(socket);
      void this.#handleUpgrade(request, socket, head)
        .catch(() => socket.destroy())
        .finally(() => this.#pendingUpgradeSockets.delete(socket));
    });
  }

  async #dispatchRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (this.#stopping) {
      response.writeHead(503);
      response.end();
      return;
    }

    const controller = new AbortController();
    const removeControllerOnAbort = (): void => {
      this.#activeHttpRequestControllers.delete(controller);
    };
    const abortOnRequestAbort = (): void => controller.abort();
    const abortOnResponseClose = (): void => {
      if (!response.writableFinished) controller.abort();
    };
    this.#activeHttpRequestControllers.add(controller);
    controller.signal.addEventListener("abort", removeControllerOnAbort, { once: true });
    request.once("aborted", abortOnRequestAbort);
    response.once("close", abortOnResponseClose);
    try {
      if (
        this.#options.onRequest &&
        (await this.#options.onRequest(request, response, controller.signal))
      ) {
        return;
      }
      if (this.#stopping || response.destroyed) return;

      if (request.url === (this.#options.healthPath ?? "/healthz")) {
        const check = this.#options.healthCheck;
        let ok = false;
        try {
          ok = (check ? await check(controller.signal) : { ok: true }).ok === true;
        } catch {
          ok = false;
        }
        if (this.#stopping || response.destroyed) return;
        const status = ok ? 200 : 503;
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok }));
        return;
      }

      response.writeHead(404);
      response.end();
    } catch {
      if (response.destroyed) return;
      if (!response.headersSent) {
        response.writeHead(500);
      }
      response.end();
    } finally {
      controller.signal.removeEventListener("abort", removeControllerOnAbort);
      request.off("aborted", abortOnRequestAbort);
      response.off("close", abortOnResponseClose);
      this.#activeHttpRequestControllers.delete(controller);
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
    if (this.#stopPromise) {
      await this.#stopPromise;
    }
    if (this.#running) {
      return;
    }
    if (this.#startPromise) {
      return this.#startPromise;
    }

    if (this.#webSocketServerClosed) {
      this.#wss = this.#createWebSocketServer();
      this.#webSocketServerClosed = false;
    }
    this.#stopping = false;
    const starting = new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      this.#server.once("error", onError);
      this.#server.listen(this.#options.port, this.#options.host, () => {
        this.#server.off("error", onError);
        this.#running = true;
        resolve();
      });
    });
    this.#startPromise = starting;
    try {
      await starting;
    } finally {
      if (this.#startPromise === starting) {
        this.#startPromise = undefined;
      }
    }
  }

  async stop(): Promise<void> {
    if (this.#stopPromise) {
      await this.#stopPromise;
      return;
    }

    const starting = this.#startPromise;
    if (!this.#running && !starting) {
      return;
    }

    this.#stopping = true;
    const stopping = Promise.resolve().then(async () => {
      if (starting) {
        await starting.catch(() => undefined);
      }
      if (!this.#running) {
        return;
      }

      for (const client of this.#wss.clients) {
        client.close();
      }
      for (const controller of this.#pendingAuthorizationControllers) {
        controller.abort();
      }
      for (const controller of this.#activeHttpRequestControllers) {
        controller.abort();
      }
      for (const socket of this.#pendingUpgradeSockets) {
        socket.destroy();
      }

      const serverClosed = new Promise<void>((resolve, reject) => {
        this.#server.close((serverError) => {
          if (serverError) {
            reject(serverError);
            return;
          }
          resolve();
        });
      });
      this.#server.closeAllConnections();

      const webSocketServerClosed = new Promise<void>((resolve, reject) => {
        this.#wss.close((wsError) => {
          if (wsError) {
            reject(wsError);
            return;
          }
          this.#webSocketServerClosed = true;
          resolve();
        });
      });
      await Promise.all([serverClosed, webSocketServerClosed]);
      this.#running = false;
    });
    this.#stopPromise = stopping;
    try {
      await stopping;
    } finally {
      if (this.#stopPromise === stopping) {
        this.#stopPromise = undefined;
      }
    }
  }

  #createWebSocketServer(): WebSocketServer {
    const options: ConstructorParameters<typeof WebSocketServer>[0] & {
      readonly closeTimeout: number;
      readonly maxFragments: number;
      readonly autoPong: boolean;
    } = {
      noServer: true,
      maxPayload: this.#maxInboundFrameBytes,
      maxFragments: this.#maxInboundFrameFragments,
      closeTimeout: this.#webSocketCloseTimeoutMs,
      autoPong: false,
    };
    return new WebSocketServer(options);
  }

  async #handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    if (this.#stopping) {
      socket.destroy();
      return;
    }

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

    const authorize = this.#options.authorizeUpgrade;
    if (authorize) {
      if (this.#pendingAuthorizations >= this.#maxPendingAuthorizations) {
        rejectUpgrade(socket, 503);
        return;
      }

      this.#pendingAuthorizations += 1;
      const authorizationController = new AbortController();
      this.#pendingAuthorizationControllers.add(authorizationController);
      let resolveSocketClosed!: () => void;
      const socketClosed = new Promise<void>((resolve) => {
        resolveSocketClosed = resolve;
      });
      const onSocketClosed = (): void => {
        authorizationController.abort();
        resolveSocketClosed();
      };
      socket.once("close", onSocketClosed);
      socket.once("error", onSocketClosed);

      const authorization = Promise.resolve()
        .then(() => authorize(request, url, matched, authorizationController.signal))
        .then(
          (result) => ({ kind: "authorized" as const, result }),
          () => ({ kind: "failed" as const }),
        );
      void authorization.then(() => {
        this.#pendingAuthorizations = Math.max(0, this.#pendingAuthorizations - 1);
        this.#pendingAuthorizationControllers.delete(authorizationController);
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<{ readonly kind: "timeout" }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "timeout" }), this.#authorizationTimeoutMs);
        timer.unref?.();
      });
      const outcome = await Promise.race([
        authorization,
        timeout,
        socketClosed.then(() => ({ kind: "socket_closed" as const })),
      ]);
      if (timer) clearTimeout(timer);
      socket.off("close", onSocketClosed);
      socket.off("error", onSocketClosed);

      if (outcome.kind !== "authorized") {
        authorizationController.abort();
        void authorization.then((lateOutcome) => {
          if (lateOutcome.kind === "authorized" && lateOutcome.result.ok) {
            this.#releaseAbortedAuthorization(lateOutcome.result.context);
          }
        });
        if (!socket.destroyed && outcome.kind !== "socket_closed") {
          rejectUpgrade(socket, outcome.kind === "timeout" ? 503 : 500);
        }
        return;
      }

      const result = outcome.result;
      if (socket.destroyed) {
        if (result.ok) this.#releaseAbortedAuthorization(result.context);
        return;
      }
      if (!result.ok) {
        rejectUpgrade(socket, result.statusCode);
        return;
      }

      let aborted = false;
      const onAbort = (): void => {
        if (aborted) {
          return;
        }
        aborted = true;
        this.#releaseAbortedAuthorization(result.context);
      };
      socket.once("error", onAbort);
      socket.once("close", onAbort);
      this.#wss.handleUpgrade(request, socket, head, (ws) => {
        socket.off("error", onAbort);
        socket.off("close", onAbort);
        this.#wss.emit("connection", ws, request);
        void this.#runConnection(ws, request, url, matched, result.context);
      });
      return;
    }

    this.#wss.handleUpgrade(request, socket, head, (ws) => {
      this.#wss.emit("connection", ws, request);
      void this.#runConnection(ws, request, url, matched);
    });
  }

  #releaseAbortedAuthorization(context: TContext): void {
    void Promise.resolve()
      .then(() => this.#options.onUpgradeAborted?.(context))
      .catch((error: unknown) => {
        void Promise.resolve()
          .then(() => this.#options.onUpgradeAbortedError?.(error, context))
          .catch(() => undefined);
      });
  }

  async #runConnection(
    ws: WebSocket,
    request: IncomingMessage,
    url: URL,
    params: Readonly<Record<string, string>>,
    upgradeContext?: TContext,
  ): Promise<void> {
    this.#limitInboundControlFrames(ws);
    try {
      await this.#options.onConnection({
        socket: ws,
        request,
        url,
        params,
        ...(upgradeContext !== undefined ? { upgradeContext } : {}),
      });
    } catch (error) {
      await this.#handleConnectionError(error, ws);
    }
  }

  #limitInboundControlFrames(ws: WebSocket): void {
    const receivedAt = new Float64Array(MAX_INBOUND_CONTROL_FRAMES_PER_WINDOW);
    let oldest = 0;
    let count = 0;
    let exceeded = false;
    const allowControlFrame = (): boolean => {
      if (exceeded) return false;
      const now = performance.now();
      while (count > 0 && now - (receivedAt[oldest] ?? now) >= INBOUND_CONTROL_FRAME_WINDOW_MS) {
        oldest = (oldest + 1) % receivedAt.length;
        count -= 1;
      }
      if (count === MAX_INBOUND_CONTROL_FRAMES_PER_WINDOW) {
        exceeded = true;
        ws.close(1008, "WebSocket control-frame rate exceeded");
        return false;
      }
      receivedAt[(oldest + count) % receivedAt.length] = now;
      count += 1;
      return true;
    };
    ws.on("ping", (payload) => {
      if (allowControlFrame()) ws.pong(payload);
    });
    ws.on("pong", () => allowControlFrame());
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

export function createNodeMediaPlane<TContext = unknown>(
  options: NodeMediaPlaneOptions<TContext>,
): NodeMediaPlane<TContext> {
  return new NodeMediaPlane(options);
}

function rejectUpgrade(socket: Duplex, statusCode: number): void {
  const reason =
    statusCode === 401 ? "Unauthorized" : statusCode === 403 ? "Forbidden" : "Rejected";
  socket.end(`HTTP/1.1 ${statusCode} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
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
