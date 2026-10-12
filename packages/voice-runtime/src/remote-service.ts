import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";

import type {
  Call,
  CallId,
  OrganizationId,
  SessionId,
  ToolCallId,
  ToolDefinition,
  ToolExecutionContext,
  UserId,
  WorkflowId,
} from "@tvic/core";
import { nowTimestamp, PCM16_16K_MONO } from "@tvic/core";
import {
  createWebClientAudioProvider,
  type WebClientAudioControlContext,
  type WebClientAudioProvider,
} from "@tvic/providers";
import type { VoiceEvent } from "@tvic/runtime";
import WebSocket from "ws";

import {
  createNodeMediaPlane,
  defineTool,
  type DefineToolInput,
  type UpgradeAuthorization,
} from "@tvic/runtime";
import type { VoiceAgent, VoiceAgentRunOptions } from "./managed-agent.js";

const PROTOCOL_VERSION = 1;
const HANDSHAKE_LIMIT_BYTES = 4_096;
const DEFAULT_CONTROL_LIMIT_BYTES = 32_768;
const MAX_SOCKET_BUFFERED_BYTES = 1_048_576;
const MAX_AUDIO_FRAME_BYTES = 65_536;
const UNREPRESENTABLE_TOOL_OUTPUT = Object.freeze({
  $tvic: "output_truncated",
  reason: "exceeds_protocol_limits",
});
const UNREPRESENTABLE_ERROR_CAUSE = Object.freeze({
  $tvic: "cause_truncated",
  reason: "exceeds_protocol_limits",
});
const UNREPRESENTABLE_ERROR_MESSAGE =
  "Error details omitted because they exceed TVIC remote protocol limits";
const UNREPRESENTABLE_ERROR_CODE = "remote.error_truncated";

export type RemoteVoiceToolDefinition = Omit<DefineToolInput<unknown, unknown>, "execute">;

export interface RemoteVoiceAgentFactoryContext {
  readonly telephony: WebClientAudioProvider;
  readonly tools: readonly ToolDefinition[];
}

export interface RemoteVoiceAgentRegistration {
  /** Stable path segment used by the client, for example `appointments`. */
  readonly id: string;
  readonly tools: readonly RemoteVoiceToolDefinition[];
  /** Build the consumer-owned TVIC agent with the supplied transport and tools. */
  readonly createAgent: (context: RemoteVoiceAgentFactoryContext) => VoiceAgent;
}

/** Identity and context returned by the consumer application's auth hook. */
export interface RemoteVoiceConnectionContext {
  readonly memoryUserId?: UserId;
  readonly organizationId?: OrganizationId;
  readonly workflowId?: WorkflowId;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly safetyIdentifier?: string;
}

export interface RemoteVoiceServiceOptions {
  readonly host?: string;
  readonly port: number;
  readonly agents: readonly RemoteVoiceAgentRegistration[];
  readonly maxControlFrameBytes?: number;
  /**
   * Optional consumer-owned WebSocket authorization. TVIC does not provide an
   * identity system; the callback may reject the upgrade or return app context.
   */
  readonly authorizeConnection?: (
    request: IncomingMessage,
    url: URL,
    agentId: string,
  ) => UpgradeAuthorization<RemoteVoiceConnectionContext>;
}

export class RemoteVoiceService {
  readonly #agents = new Map<string, RemoteVoiceAgentRuntime>();
  readonly #sessions = new Set<AbortController>();
  readonly #maxControlFrameBytes: number;
  readonly #plane: ReturnType<typeof createNodeMediaPlane<RemoteVoiceConnectionContext>>;
  #stopping = false;
  #startPromise: Promise<void> | undefined;
  #stopPromise: Promise<void> | undefined;

  constructor(options: RemoteVoiceServiceOptions) {
    if (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65_535) {
      throw new Error("port must be an integer from 0 to 65535");
    }
    const maxControlFrameBytes = options.maxControlFrameBytes ?? DEFAULT_CONTROL_LIMIT_BYTES;
    if (
      !Number.isSafeInteger(maxControlFrameBytes) ||
      maxControlFrameBytes < HANDSHAKE_LIMIT_BYTES ||
      maxControlFrameBytes > 65_536
    ) {
      throw new Error("maxControlFrameBytes must be an integer from 4096 to 65536");
    }
    this.#maxControlFrameBytes = maxControlFrameBytes;
    if (options.agents.length === 0) {
      throw new Error("at least one remote voice agent must be registered");
    }
    for (const registration of options.agents) {
      if (!isAgentRouteId(registration.id)) {
        throw new Error(`invalid remote voice agent id: ${registration.id}`);
      }
      if (this.#agents.has(registration.id)) {
        throw new Error(`duplicate remote voice agent id: ${registration.id}`);
      }
      validateRemoteTools(registration.id, registration.tools);

      const broker = new RemoteToolBroker(maxControlFrameBytes);
      const telephony = createWebClientAudioProvider({
        maxControlFrameBytes,
        deferTerminalClose: true,
        onControlMessage: (message, context) => broker.receive(message, context),
      });
      const tools = registration.tools.map((definition) => {
        let tool: ToolDefinition;
        tool = defineTool({
          ...definition,
          execute: (input, context) => broker.execute(tool, input, context),
        });
        return tool;
      });
      const agent = registration.createAgent({ telephony, tools });
      if (!agent || typeof agent.start !== "function" || typeof agent.stop !== "function") {
        throw new Error(`remote agent factory ${registration.id} must return a VoiceAgent`);
      }
      if (agent.providers.telephony !== "web-client-audio") {
        throw new Error(
          `remote agent ${registration.id} must use the supplied Web Client Audio provider`,
        );
      }
      this.#agents.set(registration.id, { agent, broker, telephony });
    }

    this.#plane = createNodeMediaPlane<RemoteVoiceConnectionContext>({
      ...(options.host !== undefined ? { host: options.host } : {}),
      port: options.port,
      path: "/v1/agents/:agentId",
      maxInboundFrameBytes: MAX_AUDIO_FRAME_BYTES,
      healthPath: "/healthz",
      healthCheck: async () => this.#healthCheck(),
      ...(options.authorizeConnection
        ? {
            authorizeUpgrade: (request, url, params) => {
              const agentId = params.agentId;
              if (!agentId || !this.#agents.has(agentId)) {
                return { ok: false as const, statusCode: 404 };
              }
              return (
                options.authorizeConnection?.(request, url, agentId) ?? {
                  ok: false as const,
                  statusCode: 403,
                }
              );
            },
          }
        : {}),
      onConnection: async (connection) => {
        await this.#handleConnection(
          connection.socket,
          connection.params.agentId,
          connection.upgradeContext,
        );
      },
      onConnectionError: (_error, socket) => socket.close(1011, "session failed"),
    });
  }

  get isRunning(): boolean {
    return this.#plane.isRunning;
  }

  get address() {
    return this.#plane.address;
  }

  start(): Promise<void> {
    if (this.#stopping) return Promise.reject(new Error("remote voice service has stopped"));
    if (!this.#startPromise) {
      const starting = this.#plane.start().finally(() => {
        if (this.#startPromise === starting) this.#startPromise = undefined;
      });
      this.#startPromise = starting;
    }
    return this.#startPromise;
  }

  stop(): Promise<void> {
    if (!this.#stopPromise) {
      this.#stopping = true;
      for (const controller of this.#sessions) controller.abort(new Error("service stopped"));
      this.#stopPromise = this.#stop();
    }
    return this.#stopPromise;
  }

  async #stop(): Promise<void> {
    const starting = this.#startPromise;
    if (starting) await starting.catch(() => undefined);
    const agentStops = [...this.#agents.values()].map(({ agent }) => agent.stop());
    const results = await Promise.allSettled(agentStops);
    await this.#plane.stop();
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [toError(result.reason)] : [],
    );
    if (failures.length > 0)
      throw new AggregateError(failures, "one or more TVIC agents failed to stop");
  }

  async #healthCheck(): Promise<{
    readonly ok: boolean;
    readonly checks: Record<string, unknown>;
  }> {
    const results = await Promise.all(
      [...this.#agents].map(async ([id, entry]) => [id, await entry.agent.healthCheck()] as const),
    );
    const checks = Object.fromEntries(
      results.map(([id, result]) => [id, { ok: result.ok, checks: result.checks }]),
    );
    return { ok: results.every(([, result]) => result.ok), checks };
  }

  async #handleConnection(
    socket: WebSocket,
    agentId: string | undefined,
    authContext: RemoteVoiceConnectionContext | undefined,
  ): Promise<void> {
    const entry = agentId ? this.#agents.get(agentId) : undefined;
    if (!entry) {
      sendJson(socket, { type: "agent.error", code: "agent_not_found", message: "Unknown agent" });
      socket.close(4404, "unknown agent");
      return;
    }
    if (this.#stopping) {
      sendJson(socket, {
        type: "agent.error",
        code: "service_stopping",
        message: "Service is stopping",
      });
      socket.close(1012, "service stopping");
      return;
    }

    const controller = new AbortController();
    this.#sessions.add(controller);
    let sessionId: SessionId | undefined;
    const onClose = (): void => {
      if (!controller.signal.aborted) controller.abort(new Error("remote client disconnected"));
      if (sessionId) entry.broker.detach(sessionId, new Error("remote client disconnected"));
    };
    socket.once("close", onClose);
    socket.once("error", onClose);

    try {
      const handshake = await readAgentStart(socket, controller.signal);
      if (controller.signal.aborted) return;

      const callId = `call_${randomUUID()}` as CallId;
      const now = nowTimestamp();
      const call: Call = {
        id: callId,
        provider: "web-client-audio",
        direction: "inbound",
        from: "remote-client",
        to: agentId ?? entry.agent.id,
        status: "connected",
        mediaTransport: { kind: "websocket", format: PCM16_16K_MONO },
        createdAt: now,
        startedAt: now,
        ...(authContext?.metadata ? { metadata: authContext.metadata } : {}),
      };
      const session = await entry.agent.start({
        call,
        channel: "web_audio",
        signal: controller.signal,
        ...(authContext?.memoryUserId ? { memoryUserId: authContext.memoryUserId } : {}),
        ...(authContext?.organizationId ? { organizationId: authContext.organizationId } : {}),
        ...(authContext?.workflowId ? { workflowId: authContext.workflowId } : {}),
        ...(authContext?.metadata ? { metadata: authContext.metadata } : {}),
        ...(authContext?.safetyIdentifier
          ? { safetyIdentifier: authContext.safetyIdentifier }
          : {}),
        callHandle: async ({ sessionId: newSessionId }) => {
          sessionId = newSessionId;
          entry.broker.attach(newSessionId, socket);
          try {
            return await entry.telephony.acceptWebSocket(socket, callId, newSessionId, {
              expectedMode: handshake.mode,
            });
          } catch (error) {
            entry.broker.detach(newSessionId, error);
            throw error;
          }
        },
      } satisfies VoiceAgentRunOptions);

      const iterator = session.run[Symbol.asyncIterator]();
      const run: AsyncIterable<VoiceEvent> = { [Symbol.asyncIterator]: () => iterator };
      if (controller.signal.aborted || socket.readyState !== WebSocket.OPEN) {
        await iterator.return?.();
        return;
      }
      if (
        !sendJson(socket, {
          type: "agent.ready",
          protocolVersion: PROTOCOL_VERSION,
          agentId,
          sessionId: session.sessionId,
          callId,
          audioFormat: PCM16_16K_MONO,
          maxControlFrameBytes: this.#maxControlFrameBytes,
        })
      ) {
        controller.abort(new Error("could not send agent.ready"));
        await iterator.return?.();
        return;
      }

      await this.#forwardEvents(run, socket, controller.signal);
    } catch {
      if (!controller.signal.aborted) {
        sendJson(socket, {
          type: "agent.error",
          code: "session_start_failed",
          message: "Could not start the configured voice agent",
        });
        socket.close(1011, "session start failed");
      }
    } finally {
      socket.off("close", onClose);
      socket.off("error", onClose);
      if (sessionId) entry.broker.detach(sessionId, new Error("session ended"));
      this.#sessions.delete(controller);
    }
  }

  async #forwardEvents(
    run: AsyncIterable<VoiceEvent>,
    socket: WebSocket,
    signal: AbortSignal,
  ): Promise<void> {
    let terminalEvent: Extract<VoiceEvent, { kind: "call_ended" }> | undefined;
    let backpressured = false;
    try {
      for await (const event of run) {
        if (signal.aborted || socket.readyState !== WebSocket.OPEN) break;
        // Audio is already delivered by WebClientAudioCallHandle as binary frames.
        if (event.kind === "audio_output") continue;
        if (event.kind === "call_ended") {
          terminalEvent = event;
          continue;
        }
        const forwarded =
          sendJson(socket, { type: "voice.event", event }, this.#maxControlFrameBytes) ||
          (event.kind === "tool_call" &&
            sendJson(
              socket,
              {
                type: "voice.event",
                event: {
                  ...event,
                  input: {
                    $tvic: "input_truncated",
                    reason: "exceeds_control_frame_limit",
                  },
                },
              },
              this.#maxControlFrameBytes,
            )) ||
          (event.kind === "tool_result" &&
            sendJson(
              socket,
              {
                type: "voice.event",
                event: { ...event, output: UNREPRESENTABLE_TOOL_OUTPUT },
              },
              this.#maxControlFrameBytes,
            )) ||
          (event.kind === "error" &&
            (sendJson(
              socket,
              boundedErrorEventEnvelope(event, event.error.code),
              this.#maxControlFrameBytes,
            ) ||
              sendJson(
                socket,
                boundedErrorEventEnvelope(event, UNREPRESENTABLE_ERROR_CODE),
                this.#maxControlFrameBytes,
              )));
        if (!forwarded) {
          backpressured = true;
          break;
        }
      }
    } catch {
      if (signal.aborted || socket.readyState !== WebSocket.OPEN) return;
      if (backpressured) {
        socket.close(1013, "client cannot keep up");
        return;
      }
      if (terminalEvent && terminalEvent.reason !== "completed") {
        if (
          !sendJson(
            socket,
            { type: "voice.event", event: terminalEvent },
            this.#maxControlFrameBytes,
          )
        ) {
          socket.close(1013, "client cannot keep up");
          return;
        }
        const endedSent = sendJson(
          socket,
          { type: "session.ended", reason: terminalEvent.reason },
          this.#maxControlFrameBytes,
        );
        socket.close(
          endedSent ? 1000 : 1013,
          endedSent ? "session ended" : "client cannot keep up",
        );
      } else {
        const errorSent = sendJson(
          socket,
          {
            type: "voice.error",
            code: "session_failed",
            message: "The voice session ended with an error",
          },
          this.#maxControlFrameBytes,
        );
        socket.close(
          errorSent ? 1011 : 1013,
          errorSent ? "session failed" : "client cannot keep up",
        );
      }
      return;
    }

    if (signal.aborted || socket.readyState !== WebSocket.OPEN) return;
    if (backpressured) {
      socket.close(1013, "client cannot keep up");
      return;
    }
    if (
      terminalEvent &&
      !sendJson(socket, { type: "voice.event", event: terminalEvent }, this.#maxControlFrameBytes)
    ) {
      socket.close(1013, "client cannot keep up");
      return;
    }
    if (
      !sendJson(
        socket,
        {
          type: "session.ended",
          ...(terminalEvent ? { reason: terminalEvent.reason } : {}),
        },
        this.#maxControlFrameBytes,
      )
    ) {
      socket.close(1013, "client cannot keep up");
      return;
    }
    socket.close(1000, "session ended");
  }
}

interface RemoteVoiceAgentRuntime {
  readonly agent: VoiceAgent;
  readonly broker: RemoteToolBroker;
  readonly telephony: WebClientAudioProvider;
}

interface AgentStartMessage {
  readonly mode: "push_to_talk" | "continuous";
}

interface PendingToolCall {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

class RemoteToolBroker {
  readonly #maxControlFrameBytes: number;
  readonly #sockets = new Map<SessionId, WebSocket>();
  readonly #pending = new Map<SessionId, Map<ToolCallId, PendingToolCall>>();

  constructor(maxControlFrameBytes: number) {
    this.#maxControlFrameBytes = maxControlFrameBytes;
  }

  attach(sessionId: SessionId, socket: WebSocket): void {
    this.#sockets.set(sessionId, socket);
  }

  detach(sessionId: SessionId, reason: unknown): void {
    this.#sockets.delete(sessionId);
    const pending = this.#pending.get(sessionId);
    this.#pending.delete(sessionId);
    if (!pending) return;
    for (const call of pending.values()) call.reject(toError(reason));
  }

  receive(
    message: Readonly<Record<string, unknown>> & { readonly type: string },
    context: WebClientAudioControlContext,
  ): boolean {
    if (message.type !== "tool.result" && message.type !== "tool.error") return false;
    if (typeof message.toolCallId !== "string" || message.toolCallId.length === 0) return false;
    const pending = this.#pending.get(context.sessionId)?.get(message.toolCallId as ToolCallId);
    if (!pending) return true; // A late response can arrive after cancellation.
    if (message.type === "tool.result") {
      if (!Object.prototype.hasOwnProperty.call(message, "output")) return false;
      pending.resolve(message.output);
      return true;
    }
    const error =
      isRecord(message.error) && typeof message.error.message === "string"
        ? message.error.message
        : undefined;
    if (error === undefined) return false;
    pending.reject(new Error(error.slice(0, 1_024)));
    return true;
  }

  execute(
    definition: ToolDefinition,
    input: unknown,
    context: ToolExecutionContext,
  ): Promise<unknown> {
    const socket = this.#sockets.get(context.sessionId);
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`Python tool worker is disconnected for ${definition.name}`));
    }
    if (context.signal.aborted) return Promise.reject(toError(context.signal.reason));

    const sessionCalls = this.#pending.get(context.sessionId) ?? new Map();
    this.#pending.set(context.sessionId, sessionCalls);
    if (sessionCalls.has(context.toolCallId)) {
      return Promise.reject(new Error(`duplicate remote tool call ${context.toolCallId}`));
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        if (settled) return;
        settled = true;
        context.signal.removeEventListener("abort", onAbort);
        sessionCalls.delete(context.toolCallId);
        if (sessionCalls.size === 0) this.#pending.delete(context.sessionId);
      };
      const settleResolve = (value: unknown): void => {
        cleanup();
        resolve(value);
      };
      const settleReject = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const onAbort = (): void => {
        const cancellationQueued = sendJson(
          socket,
          { type: "tool.cancel", toolCallId: context.toolCallId, sessionId: context.sessionId },
          this.#maxControlFrameBytes,
        );
        if (!cancellationQueued) socket.terminate();
        settleReject(toError(context.signal.reason));
      };
      const pending: PendingToolCall = {
        resolve: settleResolve,
        reject: settleReject,
      };
      sessionCalls.set(context.toolCallId, pending);
      context.signal.addEventListener("abort", onAbort, { once: true });

      const message = {
        type: "tool.call",
        toolCallId: context.toolCallId,
        sessionId: context.sessionId,
        turnId: context.turnId,
        toolId: definition.id,
        toolName: definition.name,
        attempt: context.attempt,
        idempotencyKey: `${context.sessionId}:${context.toolCallId}`,
        timeoutMs: definition.timeout.timeoutMs,
        input,
        ...(context.tenant ? { tenant: context.tenant } : {}),
      };
      if (!sendJson(socket, message, this.#maxControlFrameBytes)) {
        settleReject(new Error(`could not send Python tool call ${definition.name}`));
      }
      if (context.signal.aborted) onAbort();
    });
  }
}

export function createRemoteVoiceService(options: RemoteVoiceServiceOptions): RemoteVoiceService {
  return new RemoteVoiceService(options);
}

async function readAgentStart(socket: WebSocket, signal: AbortSignal): Promise<AgentStartMessage> {
  return await new Promise<AgentStartMessage>((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | undefined, message?: AgentStartMessage): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("close", onClose);
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else if (message) resolve(message);
      else reject(new Error("invalid agent.start message"));
    };
    const onMessage = (raw: WebSocket.RawData, isBinary: boolean): void => {
      if (isBinary) return finish(new Error("agent.start must be a JSON control frame"));
      let data: Buffer;
      try {
        data = rawToBuffer(raw);
      } catch {
        return finish(new Error("unsupported agent.start frame representation"));
      }
      if (data.byteLength > HANDSHAKE_LIMIT_BYTES) {
        return finish(new Error("agent.start exceeds 4096 bytes"));
      }
      let value: unknown;
      try {
        value = JSON.parse(data.toString("utf8"));
      } catch {
        return finish(new Error("agent.start is not valid JSON"));
      }
      if (
        !isRecord(value) ||
        value.type !== "agent.start" ||
        value.protocolVersion !== PROTOCOL_VERSION ||
        (value.mode !== "push_to_talk" && value.mode !== "continuous") ||
        typeof value.clientPlatform !== "string" ||
        value.clientPlatform.length < 1 ||
        value.clientPlatform.length > 64
      ) {
        return finish(new Error("invalid agent.start message"));
      }
      finish(undefined, { mode: value.mode });
    };
    const onClose = (): void => finish(new Error("client disconnected before agent.start"));
    const onAbort = (): void => finish(toError(signal.reason));
    const timer = setTimeout(() => finish(new Error("agent.start timed out")), 10_000);
    timer.unref?.();
    socket.on("message", onMessage);
    socket.once("close", onClose);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function validateRemoteTools(agentId: string, tools: readonly RemoteVoiceToolDefinition[]): void {
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const tool of tools) {
    if (!tool.id || !tool.name || !tool.description || !tool.inputSchema) {
      throw new Error(`remote tool on agent ${agentId} is missing a required field`);
    }
    if (ids.has(tool.id) || names.has(tool.name)) {
      throw new Error(`remote tools on agent ${agentId} must have unique ids and names`);
    }
    ids.add(tool.id);
    names.add(tool.name);
  }
}

function isAgentRouteId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedErrorEventEnvelope(
  event: Extract<VoiceEvent, { kind: "error" }>,
  code: string,
): Readonly<Record<string, unknown>> {
  return {
    type: "voice.event",
    event: {
      kind: "error",
      recoverable: event.recoverable,
      error: {
        name: event.error.name,
        code,
        category: event.error.category,
        message: UNREPRESENTABLE_ERROR_MESSAGE,
        retriable: event.error.retriable,
        ...(event.error.cause !== undefined ? { cause: UNREPRESENTABLE_ERROR_CAUSE } : {}),
      },
    },
  };
}

function rawToBuffer(value: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) return Buffer.concat(value);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  throw new Error("unsupported WebSocket frame representation");
}

function sendJson(
  socket: WebSocket,
  value: Readonly<Record<string, unknown>>,
  maxBytes = DEFAULT_CONTROL_LIMIT_BYTES,
): boolean {
  if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > MAX_SOCKET_BUFFERED_BYTES) {
    return false;
  }
  const data = stringifyWithinLimit(value, maxBytes);
  if (data === undefined) return false;
  try {
    socket.send(data);
    return true;
  } catch {
    return false;
  }
}

function stringifyWithinLimit(
  value: Readonly<Record<string, unknown>>,
  maxBytes: number,
): string | undefined {
  const parts: string[] = [];
  let byteLength = 0;
  const ancestors = new Set<object>();
  const append = (encoded: string): boolean => {
    const size = Buffer.byteLength(encoded, "utf8");
    if (byteLength + size > maxBytes) return false;
    byteLength += size;
    parts.push(encoded);
    return true;
  };

  const encode = (current: unknown, depth: number): boolean => {
    if (current === null) return append("null");
    if (current === true) return append("true");
    if (current === false) return append("false");
    if (typeof current === "string") {
      if (jsonStringByteLength(current, maxBytes) === undefined) return false;
      const encoded = JSON.stringify(current);
      return encoded !== undefined && append(encoded);
    }
    if (typeof current === "number") {
      if (
        !Number.isFinite(current) ||
        (Number.isInteger(current) && !Number.isSafeInteger(current))
      ) {
        return false;
      }
      const encoded = JSON.stringify(current);
      return encoded !== undefined && append(encoded);
    }
    if (current === undefined || typeof current === "function" || typeof current === "symbol") {
      return false;
    }
    if (typeof current !== "object" || depth >= 512 || ancestors.has(current)) return false;

    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        if (Object.getPrototypeOf(current) !== Array.prototype) return false;
        const inheritedToJSON = Object.getOwnPropertyDescriptor(Array.prototype, "toJSON");
        if (
          inheritedToJSON &&
          (typeof inheritedToJSON.value === "function" || !("value" in inheritedToJSON))
        ) {
          return false;
        }
        const ownToJSON = Object.getOwnPropertyDescriptor(current, "toJSON");
        if (ownToJSON && (typeof ownToJSON.value === "function" || !("value" in ownToJSON))) {
          return false;
        }
        const lengthDescriptor = Object.getOwnPropertyDescriptor(current, "length");
        if (!lengthDescriptor || !("value" in lengthDescriptor)) return false;
        const length = lengthDescriptor.value;
        if (!Number.isSafeInteger(length) || length < 0 || length > maxBytes) return false;
        if (!append("[")) return false;
        for (let index = 0; index < length; index += 1) {
          if (index > 0 && !append(",")) return false;
          const key = String(index);
          const descriptor = Object.getOwnPropertyDescriptor(current, key);
          if (descriptor && !("value" in descriptor)) return false;
          if (
            !descriptor &&
            (Object.getOwnPropertyDescriptor(Array.prototype, key) ||
              Object.getOwnPropertyDescriptor(Object.prototype, key))
          ) {
            return false;
          }
          const child = descriptor?.value;
          if (child === undefined || typeof child === "function" || typeof child === "symbol") {
            if (!append("null")) return false;
          } else if (!encode(child, depth + 1)) {
            return false;
          }
        }
        return append("]");
      }

      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) return false;
      const inheritedToJSON = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
      if (
        inheritedToJSON &&
        (typeof inheritedToJSON.value === "function" || !("value" in inheritedToJSON))
      ) {
        return false;
      }
      const ownToJSON = Object.getOwnPropertyDescriptor(current, "toJSON");
      if (ownToJSON && (typeof ownToJSON.value === "function" || !("value" in ownToJSON))) {
        return false;
      }
      if (!append("{")) return false;
      let first = true;
      for (const key in current) {
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor?.enumerable) continue;
        if (!("value" in descriptor)) return false;
        const child = descriptor.value;
        if (child === undefined || typeof child === "function" || typeof child === "symbol") {
          continue;
        }
        if (jsonStringByteLength(key, maxBytes) === undefined) return false;
        const encodedKey = JSON.stringify(key);
        if (encodedKey === undefined) return false;
        if ((!first && !append(",")) || !append(encodedKey) || !append(":")) return false;
        if (!encode(child, depth + 1)) return false;
        first = false;
      }
      return append("}");
    } finally {
      ancestors.delete(current);
    }
  };

  try {
    if (!encode(value, 0)) return undefined;
    return parts.join("");
  } catch {
    return undefined;
  }
}

function jsonStringByteLength(value: string, maxBytes: number): number | undefined {
  let size = 2;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (character === '"' || character === "\\") size += 2;
    else if (code <= 0x1f)
      size +=
        code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d ? 2 : 6;
    else if (character.length === 1 && code >= 0xd800 && code <= 0xdfff) size += 6;
    else if (character.length === 2) size += 4;
    else if (code <= 0x7f) size += 1;
    else if (code <= 0x7ff) size += 2;
    else size += 3;
    if (size > maxBytes) return undefined;
  }
  return size;
}

function toError(value: unknown): Error {
  return value instanceof Error
    ? value
    : new Error(typeof value === "string" ? value : "operation cancelled");
}
