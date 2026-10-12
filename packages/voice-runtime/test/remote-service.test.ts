import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  LLMProvider,
  ProviderCapabilities,
  SessionId,
  SpeechToTextProvider,
  TextToSpeechProvider,
  TranscriptEvent,
  ToolExecutionContext,
  UserId,
  VoiceAgentRunOptions,
} from "../src/index.js";
import {
  AsyncQueue,
  createVoiceAgent,
  createRemoteVoiceService,
  NodeMediaPlane,
  PCM16_16K_MONO,
  type RemoteVoiceAgentFactoryContext,
  type RemoteVoiceService,
  type VoiceAgent,
  type VoiceAgentSession,
  type VoiceEvent,
} from "../src/index.js";

const MANAGED_TEST_CAPABILITIES = {
  streaming: { input: true, output: true, native: true },
  cancellation: { request: true, output: true, buffer: true, truncation: true },
  transports: ["websocket"],
  audio: { input: [PCM16_16K_MONO], output: [PCM16_16K_MONO] },
  tools: { functionCalling: true, parallelCalls: true },
  playout: { clearBuffer: true, acknowledgement: true, position: true },
} satisfies ProviderCapabilities;

describe("remote voice service", () => {
  let service: RemoteVoiceService | undefined;
  let socket: WebSocket | undefined;

  afterEach(async () => {
    socket?.close();
    socket = undefined;
    await service?.stop();
    service = undefined;
  });

  it("waits for an in-flight listener start before stopping", async () => {
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const originalStart = NodeMediaPlane.prototype.start;
    const originalStop = NodeMediaPlane.prototype.stop;
    let plane: NodeMediaPlane<unknown> | undefined;
    service = createRemoteVoiceService({
      host: "127.0.0.1",
      port: 0,
      agents: [{ id: "appointments", tools: [], createAgent: () => fakeAgent([]) }],
    });
    const startSpy = vi.spyOn(NodeMediaPlane.prototype, "start").mockImplementation(async function (
      this: NodeMediaPlane<unknown>,
    ) {
      plane = this;
      await startGate;
      await originalStart.call(this);
    });
    const starting = service.start();
    const stopping = service.stop();

    try {
      const stopState = await Promise.race([
        stopping.then(() => "stopped" as const),
        new Promise<"pending">((resolve) => setImmediate(() => resolve("pending"))),
      ]);
      expect(stopState).toBe("pending");

      releaseStart();
      await Promise.all([starting, stopping]);
      expect(service.isRunning).toBe(false);
      expect(service.address).toBeNull();
    } finally {
      releaseStart();
      await starting.catch(() => undefined);
      if (plane?.isRunning) await originalStop.call(plane);
      startSpy.mockRestore();
    }
  });

  it("uses the default output schema for remote tools that omit one", () => {
    service = createRemoteVoiceService({
      host: "127.0.0.1",
      port: 0,
      agents: [
        {
          id: "appointments",
          tools: [
            {
              id: "lookup_customer",
              name: "lookup_customer",
              description: "Looks up a customer.",
              inputSchema: { type: "object" },
            },
          ],
          createAgent: ({ tools }) => {
            expect(tools[0]?.outputSchema).toEqual({ type: "object" });
            return fakeAgent(tools);
          },
        },
      ],
    });
  });

  it("returns a run whose start finishes after the client disconnects", async () => {
    let releaseStart!: () => void;
    let resolveStartEntered!: () => void;
    let resolveSignalAborted!: () => void;
    let runReturned!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const startEntered = new Promise<void>((resolve) => {
      resolveStartEntered = resolve;
    });
    const signalAborted = new Promise<void>((resolve) => {
      resolveSignalAborted = resolve;
    });
    const iteratorReturned = new Promise<void>((resolve) => {
      runReturned = resolve;
    });
    const agent = fakeAgent([]);
    vi.spyOn(agent, "start").mockImplementation(async (options: VoiceAgentRunOptions) => {
      resolveStartEntered();
      options.signal?.addEventListener("abort", resolveSignalAborted, { once: true });
      await startGate;
      const iterator: AsyncIterator<VoiceEvent> = {
        async next() {
          return new Promise<IteratorResult<VoiceEvent>>(() => undefined);
        },
        async return() {
          runReturned();
          return { done: true, value: undefined };
        },
      };
      return {
        sessionId: "session_disconnect_during_start" as SessionId,
        run: { [Symbol.asyncIterator]: () => iterator } as unknown as VoiceAgentSession["run"],
      };
    });
    service = createRemoteVoiceService({
      host: "127.0.0.1",
      port: 0,
      agents: [{ id: "appointments", tools: [], createAgent: () => agent }],
    });
    await service.start();
    const address = service.address;
    if (!address) throw new Error("service did not bind a TCP address");

    socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/agents/appointments`);
    await opened(socket);
    socket.send(
      JSON.stringify({
        type: "agent.start",
        protocolVersion: 1,
        mode: "push_to_talk",
        clientPlatform: "test",
      }),
    );
    const entered = await Promise.race([
      startEntered.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000)),
    ]);
    expect(entered).toBe(true);
    socket.terminate();

    try {
      const aborted = await Promise.race([
        signalAborted.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000)),
      ]);
      releaseStart();
      const returned = await Promise.race([
        iteratorReturned.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000)),
      ]);
      expect(aborted).toBe(true);
      expect(returned).toBe(true);
    } finally {
      releaseStart();
    }
  });

  it("bounds inbound worker frames at the audio protocol limit", async () => {
    service = createRemoteVoiceService({
      host: "127.0.0.1",
      port: 0,
      agents: [{ id: "appointments", tools: [], createAgent: () => fakeAgent([]) }],
    });
    await service.start();
    const address = service.address;
    if (!address) throw new Error("service did not bind a TCP address");

    socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/agents/appointments`);
    await opened(socket);
    const closed = new Promise<number>((resolve) => socket?.once("close", (code) => resolve(code)));
    socket.send(Buffer.alloc(65_537));

    await expect(closed).resolves.toBe(1009);
  });

  it("starts a named agent and completes a Python-owned tool call on the media socket", async () => {
    service = createRemoteVoiceService({
      host: "127.0.0.1",
      port: 0,
      agents: [
        {
          id: "appointments",
          tools: [
            {
              id: "lookup_customer",
              name: "lookup_customer",
              version: "1.0.0",
              description: "Looks up a customer.",
              inputSchema: { type: "object", required: ["email"] },
              outputSchema: { type: "object", required: ["found"] },
            },
          ],
          createAgent: ({ tools }: RemoteVoiceAgentFactoryContext) => fakeAgent(tools),
        },
      ],
      authorizeConnection: () => ({
        ok: true,
        context: { memoryUserId: "app_user_1" as UserId },
      }),
    });
    await service.start();
    const address = service.address;
    if (!address) throw new Error("service did not bind a TCP address");

    socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/agents/appointments`);
    await opened(socket);
    const messages = new SocketMessages(socket);
    socket.send(
      JSON.stringify({
        type: "agent.start",
        protocolVersion: 1,
        mode: "push_to_talk",
        clientPlatform: "python",
      }),
    );

    const agentReady = await messages.next((value) => value.type === "agent.ready");
    expect(agentReady).toMatchObject({
      type: "agent.ready",
      protocolVersion: 1,
      agentId: "appointments",
      sessionId: "session_remote_test",
      audioFormat: PCM16_16K_MONO,
      maxControlFrameBytes: 32_768,
    });

    socket.send(
      JSON.stringify({
        type: "session.start",
        protocolVersion: 1,
        mode: "push_to_talk",
        clientPlatform: "python",
        audioFormat: PCM16_16K_MONO,
      }),
    );
    expect(await messages.next((value) => value.type === "session.ready")).toMatchObject({
      type: "session.ready",
      sessionId: "session_remote_test",
    });

    const toolCall = await messages.next((value) => value.type === "tool.call");
    expect(toolCall).toMatchObject({
      type: "tool.call",
      toolCallId: "tool_remote_test",
      toolName: "lookup_customer",
      input: { email: "person@example.com" },
      idempotencyKey: "session_remote_test:tool_remote_test",
      tenant: { userId: "app_user_1" },
    });
    socket.send(
      JSON.stringify({
        type: "tool.result",
        toolCallId: toolCall.toolCallId,
        output: { found: true },
      }),
    );

    expect(
      await messages.next(
        (value) =>
          value.type === "voice.event" &&
          isRecord(value.event) &&
          value.event.kind === "tool_result",
      ),
    ).toMatchObject({
      type: "voice.event",
      event: { kind: "tool_result", output: { found: true } },
    });
  });

  it("disconnects the worker when a tool cancellation cannot be queued", async () => {
    const toolController = new AbortController();
    let releaseAgent!: () => void;
    const agentAfterError = new Promise<void>((resolve) => {
      releaseAgent = resolve;
    });
    service = createRemoteVoiceService({
      host: "127.0.0.1",
      port: 0,
      agents: [
        {
          id: "appointments",
          tools: [
            {
              id: "lookup_customer",
              name: "lookup_customer",
              description: "Looks up a customer.",
              inputSchema: { type: "object" },
            },
          ],
          createAgent: ({ tools }) =>
            fakeAgent(tools, {
              toolSignal: toolController.signal,
              afterToolError: () => agentAfterError,
            }),
        },
      ],
    });
    await service.start();
    const address = service.address;
    if (!address) throw new Error("service did not bind a TCP address");

    socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/agents/appointments`);
    await opened(socket);
    const closed = new Promise<void>((resolve) => socket?.once("close", () => resolve()));
    const messages = new SocketMessages(socket);
    socket.send(
      JSON.stringify({
        type: "agent.start",
        protocolVersion: 1,
        mode: "push_to_talk",
        clientPlatform: "test",
      }),
    );
    await messages.next((value) => value.type === "agent.ready");
    socket.send(
      JSON.stringify({
        type: "session.start",
        protocolVersion: 1,
        mode: "push_to_talk",
        clientPlatform: "test",
        audioFormat: PCM16_16K_MONO,
      }),
    );
    await messages.next((value) => value.type === "session.ready");
    await messages.next((value) => value.type === "tool.call");

    const bufferedAmount = vi
      .spyOn(WebSocket.prototype, "bufferedAmount", "get")
      .mockReturnValue(Number.MAX_SAFE_INTEGER);
    try {
      toolController.abort(new Error("tool call timed out"));
      const disconnected = await Promise.race([
        closed.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250)),
      ]);
      expect(disconnected).toBe(true);
    } finally {
      bufferedAmount.mockRestore();
      releaseAgent();
    }
  });

  it("rejects an unsupported wire version before starting the configured agent", async () => {
    let starts = 0;
    service = createRemoteVoiceService({
      host: "127.0.0.1",
      port: 0,
      agents: [
        {
          id: "appointments",
          tools: [],
          createAgent: () => {
            const agent = fakeAgent([]);
            return {
              ...agent,
              async start(options) {
                starts += 1;
                return await agent.start(options);
              },
            };
          },
        },
      ],
    });
    await service.start();
    const address = service.address;
    if (!address) throw new Error("service did not bind a TCP address");

    socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/agents/appointments`);
    await opened(socket);
    const messages = new SocketMessages(socket);
    socket.send(
      JSON.stringify({
        type: "agent.start",
        protocolVersion: 2,
        mode: "push_to_talk",
        clientPlatform: "python",
      }),
    );

    expect(await messages.next((value) => value.type === "agent.error")).toMatchObject({
      type: "agent.error",
      code: "session_start_failed",
    });
    expect(starts).toBe(0);
  });

  it("forwards terminal runtime errors before ending the Python session", async () => {
    service = createRemoteVoiceService({
      host: "127.0.0.1",
      port: 0,
      agents: [{ id: "appointments", tools: [], createAgent: () => failingAgent() }],
    });
    await service.start();
    const address = service.address;
    if (!address) throw new Error("service did not bind a TCP address");

    socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/agents/appointments`);
    await opened(socket);
    const messages = new SocketMessages(socket);
    socket.send(
      JSON.stringify({
        type: "agent.start",
        protocolVersion: 1,
        mode: "push_to_talk",
        clientPlatform: "python",
      }),
    );
    await messages.next((value) => value.type === "agent.ready");
    socket.send(
      JSON.stringify({
        type: "session.start",
        protocolVersion: 1,
        mode: "push_to_talk",
        clientPlatform: "python",
        audioFormat: PCM16_16K_MONO,
      }),
    );
    await messages.next((value) => value.type === "session.ready");

    expect(
      await messages.next(
        (value) =>
          value.type === "voice.event" && isRecord(value.event) && value.event.kind === "error",
      ),
    ).toMatchObject({ type: "voice.event", event: { kind: "error", recoverable: false } });
    expect(
      await messages.next(
        (value) =>
          value.type === "voice.event" &&
          isRecord(value.event) &&
          value.event.kind === "call_ended",
      ),
    ).toMatchObject({ type: "voice.event", event: { kind: "call_ended", reason: "failed" } });
    expect(await messages.next((value) => value.type === "session.ended")).toMatchObject({
      type: "session.ended",
      reason: "failed",
    });
  });

  it("finishes run cleanup before sending the terminal control", async () => {
    let finalizationError: unknown;
    let resolveFinalization!: () => void;
    let resolveFinalizationStarted!: () => void;
    const finalization = new Promise<void>((resolve) => {
      resolveFinalization = resolve;
    });
    const finalizationStarted = new Promise<void>((resolve) => {
      resolveFinalizationStarted = resolve;
    });
    service = createRemoteVoiceService({
      host: "127.0.0.1",
      port: 0,
      agents: [
        {
          id: "appointments",
          tools: [],
          createAgent: () =>
            completingAgent(
              (error) => {
                finalizationError = error;
                resolveFinalization();
              },
              {
                onFinalizationStarted: resolveFinalizationStarted,
                waitForFinalization: () => finalization,
              },
            ),
        },
      ],
    });
    await service.start();
    const address = service.address;
    if (!address) throw new Error("service did not bind a TCP address");

    socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/agents/appointments`);
    await opened(socket);
    const messages = new SocketMessages(socket);
    socket.send(
      JSON.stringify({
        type: "agent.start",
        protocolVersion: 1,
        mode: "push_to_talk",
        clientPlatform: "python",
      }),
    );
    await messages.next((value) => value.type === "agent.ready");
    socket.send(
      JSON.stringify({
        type: "session.start",
        protocolVersion: 1,
        mode: "push_to_talk",
        clientPlatform: "python",
        audioFormat: PCM16_16K_MONO,
      }),
    );
    await messages.next((value) => value.type === "session.ready");

    try {
      await finalizationStarted;
      socket.send(JSON.stringify({ type: "client.ping", nonce: "finalization-check" }));
      expect(await messages.next((value) => value.type === "server.pong")).toMatchObject({
        type: "server.pong",
        nonce: "finalization-check",
      });
      expect(
        messages.has(
          (value) =>
            value.type === "voice.event" &&
            isRecord(value.event) &&
            value.event.kind === "call_ended",
        ),
      ).toBe(false);

      resolveFinalization();
      expect(
        await messages.next(
          (value) =>
            value.type === "voice.event" &&
            isRecord(value.event) &&
            value.event.kind === "call_ended",
        ),
      ).toMatchObject({ type: "voice.event", event: { kind: "call_ended", reason: "completed" } });
      expect(await messages.next((value) => value.type === "session.ended")).toMatchObject({
        type: "session.ended",
        reason: "completed",
      });
      await finalization;
      expect(finalizationError).toBeUndefined();
    } finally {
      resolveFinalization();
    }
  });

  it("bounds an oversized error event after run cleanup completes", async () => {
    let finalizationError: unknown;
    let resolveFinalization!: () => void;
    let resolveFinalizationStarted!: () => void;
    const finalization = new Promise<void>((resolve) => {
      resolveFinalization = resolve;
    });
    const finalizationStarted = new Promise<void>((resolve) => {
      resolveFinalizationStarted = resolve;
    });
    const oversizedEvent: VoiceEvent = {
      kind: "error",
      error: {
        code: `test.${"x".repeat(5_000)}`,
        category: "internal",
        name: "InternalError",
        message: "test error",
        retriable: false,
      },
      recoverable: true,
    };
    service = createRemoteVoiceService({
      host: "127.0.0.1",
      port: 0,
      maxControlFrameBytes: 4_096,
      agents: [
        {
          id: "appointments",
          tools: [],
          createAgent: () =>
            completingAgent(
              (error) => {
                finalizationError = error;
              },
              {
                event: oversizedEvent,
                onFinalizationStarted: resolveFinalizationStarted,
                waitForFinalization: () => finalization,
              },
            ),
        },
      ],
    });
    await service.start();
    const address = service.address;
    if (!address) throw new Error("service did not bind a TCP address");

    socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/agents/appointments`);
    await opened(socket);
    const messages = new SocketMessages(socket);
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      socket?.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    const originalStringify = JSON.stringify.bind(JSON);
    let oversizedEventWasSerialized = false;
    const stringifySpy = vi.spyOn(JSON, "stringify").mockImplementation((value) => {
      if (isRecord(value) && value.type === "voice.event" && value.event === oversizedEvent) {
        oversizedEventWasSerialized = true;
        throw new Error("oversized event must be rejected before JSON serialization");
      }
      return originalStringify(value);
    });
    socket.send(
      JSON.stringify({
        type: "agent.start",
        protocolVersion: 1,
        mode: "push_to_talk",
        clientPlatform: "test",
      }),
    );
    await messages.next((value) => value.type === "agent.ready");
    socket.send(
      JSON.stringify({
        type: "session.start",
        protocolVersion: 1,
        mode: "push_to_talk",
        clientPlatform: "test",
        audioFormat: PCM16_16K_MONO,
      }),
    );
    await messages.next((value) => value.type === "session.ready");
    await finalizationStarted;

    try {
      expect(socket.readyState).toBe(WebSocket.OPEN);
      resolveFinalization();
      expect(await closed).toMatchObject({ code: 1000, reason: "session ended" });
      expect(finalizationError).toBeUndefined();
      const forwarded = await messages.next(
        (value) =>
          value.type === "voice.event" && isRecord(value.event) && value.event.kind === "error",
      );
      expect(forwarded.event).toMatchObject({
        kind: "error",
        error: {
          code: "remote.error_truncated",
          message: "Error details omitted because they exceed TVIC remote protocol limits",
        },
      });
      expect((forwarded.event as { error: Record<string, unknown> }).error).not.toHaveProperty(
        "cause",
      );
    } finally {
      stringifySpy.mockRestore();
      resolveFinalization();
    }
    expect(oversizedEventWasSerialized).toBe(false);
  });

  it.each([
    { description: "unsafe integer-valued", cause: { detail: Number.MAX_SAFE_INTEGER + 1 } },
    { description: "over-deep", cause: createDeeplyNestedValue() },
  ])("replaces $description error causes with a bounded marker", async ({ cause }) => {
    const invalidEvent: VoiceEvent = {
      kind: "error",
      error: {
        code: "test.invalid_cause",
        category: "internal",
        name: "InternalError",
        message: "test error",
        retriable: false,
        cause,
      },
      recoverable: true,
    };
    service = createRemoteVoiceService({
      host: "127.0.0.1",
      port: 0,
      agents: [
        {
          id: "appointments",
          tools: [],
          createAgent: () => completingAgent(() => undefined, { event: invalidEvent }),
        },
      ],
    });
    await service.start();
    const address = service.address;
    if (!address) throw new Error("service did not bind a TCP address");

    socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/agents/appointments`);
    await opened(socket);
    const messages = new SocketMessages(socket);
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      socket?.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    const originalStringify = JSON.stringify.bind(JSON);
    let invalidEventWasSerialized = false;
    const stringifySpy = vi.spyOn(JSON, "stringify").mockImplementation((value) => {
      if (isRecord(value) && value.type === "voice.event" && value.event === invalidEvent) {
        invalidEventWasSerialized = true;
      }
      return originalStringify(value);
    });
    socket.send(
      JSON.stringify({
        type: "agent.start",
        protocolVersion: 1,
        mode: "push_to_talk",
        clientPlatform: "test",
      }),
    );
    await messages.next((value) => value.type === "agent.ready");
    socket.send(
      JSON.stringify({
        type: "session.start",
        protocolVersion: 1,
        mode: "push_to_talk",
        clientPlatform: "test",
        audioFormat: PCM16_16K_MONO,
      }),
    );
    await messages.next((value) => value.type === "session.ready");

    try {
      expect(await closed).toMatchObject({ code: 1000, reason: "session ended" });
      const forwarded = await messages.next(
        (value) =>
          value.type === "voice.event" && isRecord(value.event) && value.event.kind === "error",
      );
      expect(forwarded.event).toMatchObject({
        kind: "error",
        error: {
          code: "test.invalid_cause",
          message: "Error details omitted because they exceed TVIC remote protocol limits",
          cause: { $tvic: "cause_truncated", reason: "exceeds_protocol_limits" },
        },
      });
    } finally {
      stringifySpy.mockRestore();
    }
    expect(invalidEventWasSerialized).toBe(false);
  });

  it("serializes the validated data snapshot of Proxy-backed event values", async () => {
    const output = new Proxy(
      { value: 1 },
      {
        get(target, property, receiver) {
          if (property === "value") return Number.POSITIVE_INFINITY;
          return Reflect.get(target, property, receiver);
        },
      },
    );
    const event: VoiceEvent = {
      kind: "tool_result",
      toolCallId: "tool_proxy_output" as Extract<VoiceEvent, { kind: "tool_result" }>["toolCallId"],
      output,
      latencyMs: 1,
    };
    service = createRemoteVoiceService({
      host: "127.0.0.1",
      port: 0,
      agents: [
        {
          id: "appointments",
          tools: [],
          createAgent: () => completingAgent(() => undefined, { event }),
        },
      ],
    });
    await service.start();
    const address = service.address;
    if (!address) throw new Error("service did not bind a TCP address");

    socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/agents/appointments`);
    await opened(socket);
    const messages = new SocketMessages(socket);
    socket.send(
      JSON.stringify({
        type: "agent.start",
        protocolVersion: 1,
        mode: "push_to_talk",
        clientPlatform: "test",
      }),
    );
    await messages.next((value) => value.type === "agent.ready");
    socket.send(
      JSON.stringify({
        type: "session.start",
        protocolVersion: 1,
        mode: "push_to_talk",
        clientPlatform: "test",
        audioFormat: PCM16_16K_MONO,
      }),
    );
    await messages.next((value) => value.type === "session.ready");

    const forwarded = await messages.next((value) => value.type === "voice.event");
    expect(forwarded.event).toMatchObject({
      kind: "tool_result",
      output: { value: 1 },
    });
  });

  it("keeps oversized tool input from being mistaken for socket backpressure", async () => {
    const input = { payload: "x".repeat(33_000) };
    const event: VoiceEvent = {
      kind: "tool_call",
      toolCallId: "tool_oversized_input" as Extract<
        VoiceEvent,
        { kind: "tool_call" }
      >["toolCallId"],
      toolName: "lookup_customer",
      input,
    };
    service = createRemoteVoiceService({
      host: "127.0.0.1",
      port: 0,
      agents: [
        {
          id: "appointments",
          tools: [],
          createAgent: () => completingAgent(() => undefined, { event }),
        },
      ],
    });
    await service.start();
    const address = service.address;
    if (!address) throw new Error("service did not bind a TCP address");

    socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/agents/appointments`);
    await opened(socket);
    const messages = new SocketMessages(socket);
    const closed = new Promise<number>((resolve) => socket?.once("close", (code) => resolve(code)));
    socket.send(
      JSON.stringify({
        type: "agent.start",
        protocolVersion: 1,
        mode: "push_to_talk",
        clientPlatform: "test",
      }),
    );
    await messages.next((value) => value.type === "agent.ready");
    socket.send(
      JSON.stringify({
        type: "session.start",
        protocolVersion: 1,
        mode: "push_to_talk",
        clientPlatform: "test",
        audioFormat: PCM16_16K_MONO,
      }),
    );
    await messages.next((value) => value.type === "session.ready");

    await expect(closed).resolves.toBe(1000);
    const forwarded = await messages.next(
      (value) =>
        value.type === "voice.event" && isRecord(value.event) && value.event.kind === "tool_call",
    );
    expect(forwarded.event).toMatchObject({
      kind: "tool_call",
      input: { $tvic: "input_truncated", reason: "exceeds_control_frame_limit" },
    });
    expect(await messages.next((value) => value.type === "session.ended")).toMatchObject({
      type: "session.ended",
    });
  });

  it.each([
    ["near-limit output", { payload: "x".repeat(3_980) }],
    ["over-deep output", createDeeplyNestedValue()],
  ])("keeps %s from being mistaken for socket backpressure", async (_description, output) => {
    const event: VoiceEvent = {
      kind: "tool_result",
      toolCallId: "tool_result_frame_limit" as Extract<
        VoiceEvent,
        { kind: "tool_result" }
      >["toolCallId"],
      output,
      latencyMs: 1,
    };
    service = createRemoteVoiceService({
      host: "127.0.0.1",
      port: 0,
      maxControlFrameBytes: 4_096,
      agents: [
        {
          id: "appointments",
          tools: [],
          createAgent: () => completingAgent(() => undefined, { event }),
        },
      ],
    });
    await service.start();
    const address = service.address;
    if (!address) throw new Error("service did not bind a TCP address");

    socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/agents/appointments`);
    await opened(socket);
    const messages = new SocketMessages(socket);
    const closed = new Promise<number>((resolve) => socket?.once("close", (code) => resolve(code)));
    socket.send(
      JSON.stringify({
        type: "agent.start",
        protocolVersion: 1,
        mode: "push_to_talk",
        clientPlatform: "test",
      }),
    );
    await messages.next((value) => value.type === "agent.ready");
    socket.send(
      JSON.stringify({
        type: "session.start",
        protocolVersion: 1,
        mode: "push_to_talk",
        clientPlatform: "test",
        audioFormat: PCM16_16K_MONO,
      }),
    );
    await messages.next((value) => value.type === "session.ready");

    await expect(closed).resolves.toBe(1000);
    const forwarded = await messages.next(
      (value) =>
        value.type === "voice.event" && isRecord(value.event) && value.event.kind === "tool_result",
    );
    expect(forwarded.event).toMatchObject({
      kind: "tool_result",
      output: { $tvic: "output_truncated", reason: "exceeds_protocol_limits" },
    });
    expect(await messages.next((value) => value.type === "session.ended")).toMatchObject({
      type: "session.ended",
      reason: "completed",
    });
  });

  it("bounds inherited sparse-array values before JSON serialization", async () => {
    const inheritedIndex = "1";
    const previousDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, inheritedIndex);
    const inheritedValue = "x".repeat(8_000);
    const sparseOutput = new Array(2);
    const sparseEvent: VoiceEvent = {
      kind: "tool_result",
      toolCallId: "tool_sparse_array" as Extract<VoiceEvent, { kind: "tool_result" }>["toolCallId"],
      output: sparseOutput,
      latencyMs: 1,
    };
    service = createRemoteVoiceService({
      host: "127.0.0.1",
      port: 0,
      maxControlFrameBytes: 4_096,
      agents: [
        {
          id: "appointments",
          tools: [],
          createAgent: () => completingAgent(() => undefined, { event: sparseEvent }),
        },
      ],
    });
    await service.start();
    const address = service.address;
    if (!address) throw new Error("service did not bind a TCP address");

    socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/agents/appointments`);
    await opened(socket);
    const messages = new SocketMessages(socket);
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      socket?.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    const originalStringify = JSON.stringify.bind(JSON);
    let sparseEventWasSerialized = false;
    const stringifySpy = vi.spyOn(JSON, "stringify").mockImplementation((value) => {
      if (isRecord(value) && value.type === "voice.event" && value.event === sparseEvent) {
        sparseEventWasSerialized = true;
      }
      return originalStringify(value);
    });
    Object.defineProperty(Array.prototype, inheritedIndex, {
      value: inheritedValue,
      configurable: true,
      writable: true,
    });

    try {
      socket.send(
        JSON.stringify({
          type: "agent.start",
          protocolVersion: 1,
          mode: "push_to_talk",
          clientPlatform: "test",
        }),
      );
      await messages.next((value) => value.type === "agent.ready");
      socket.send(
        JSON.stringify({
          type: "session.start",
          protocolVersion: 1,
          mode: "push_to_talk",
          clientPlatform: "test",
          audioFormat: PCM16_16K_MONO,
        }),
      );
      await messages.next((value) => value.type === "session.ready");
      expect(await closed).toMatchObject({ code: 1000, reason: "session ended" });
      const forwarded = await messages.next(
        (value) =>
          value.type === "voice.event" &&
          isRecord(value.event) &&
          value.event.kind === "tool_result",
      );
      expect(forwarded.event).toMatchObject({
        kind: "tool_result",
        output: { $tvic: "output_truncated", reason: "exceeds_protocol_limits" },
      });
    } finally {
      stringifySpy.mockRestore();
      if (previousDescriptor) {
        Object.defineProperty(Array.prototype, inheritedIndex, previousDescriptor);
      } else {
        delete (Array.prototype as unknown as Record<string, unknown>)[inheritedIndex];
      }
    }
    expect(sparseEventWasSerialized).toBe(false);
  });

  it("uses the negotiated control frame limit when forwarding voice events", async () => {
    const largeMessage = '"\\\t💛\ud800'.repeat(3_000);
    const largeEvent: VoiceEvent = {
      kind: "error",
      error: {
        code: "test.large",
        category: "internal",
        name: "InternalError",
        message: largeMessage,
        retriable: false,
      },
      recoverable: true,
    };
    const controlLimit = Buffer.byteLength(
      JSON.stringify({ type: "voice.event", event: largeEvent }),
      "utf8",
    );
    service = createRemoteVoiceService({
      host: "127.0.0.1",
      port: 0,
      maxControlFrameBytes: controlLimit,
      agents: [
        {
          id: "appointments",
          tools: [],
          createAgent: () => completingAgent(() => undefined, { event: largeEvent }),
        },
      ],
    });
    await service.start();
    const address = service.address;
    if (!address) throw new Error("service did not bind a TCP address");

    socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/agents/appointments`);
    await opened(socket);
    const messages = new SocketMessages(socket);
    socket.send(
      JSON.stringify({
        type: "agent.start",
        protocolVersion: 1,
        mode: "push_to_talk",
        clientPlatform: "test",
      }),
    );
    await messages.next((value) => value.type === "agent.ready");
    socket.send(
      JSON.stringify({
        type: "session.start",
        protocolVersion: 1,
        mode: "push_to_talk",
        clientPlatform: "test",
        audioFormat: PCM16_16K_MONO,
      }),
    );
    await messages.next((value) => value.type === "session.ready");

    const forwarded = await messages.next(
      (value) =>
        value.type === "voice.event" &&
        isRecord(value.event) &&
        isRecord(value.event.error) &&
        typeof value.event.error.message === "string",
    );
    expect(forwarded).toMatchObject({ type: "voice.event" });
    expect((forwarded.event as { error: { message: string } }).error.message).toBe(largeMessage);
  });

  it("waits for managed remote-hangup finalization before ending the socket", async () => {
    service = createRemoteVoiceService({
      host: "127.0.0.1",
      port: 0,
      agents: [
        {
          id: "appointments",
          tools: [],
          createAgent: ({ telephony }) => managedRemoteHangupAgent(telephony),
        },
      ],
    });
    await service.start();
    const address = service.address;
    if (!address) throw new Error("service did not bind a TCP address");

    socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/agents/appointments`);
    await opened(socket);
    const messages = new SocketMessages(socket);
    socket.send(
      JSON.stringify({
        type: "agent.start",
        protocolVersion: 1,
        mode: "push_to_talk",
        clientPlatform: "test",
      }),
    );
    await messages.next((value) => value.type === "agent.ready");
    socket.send(
      JSON.stringify({
        type: "session.start",
        protocolVersion: 1,
        mode: "push_to_talk",
        clientPlatform: "test",
        audioFormat: PCM16_16K_MONO,
      }),
    );
    await messages.next((value) => value.type === "session.ready");
    socket.send(JSON.stringify({ type: "session.end" }));

    expect(
      await messages.next(
        (value) =>
          value.type === "voice.event" &&
          isRecord(value.event) &&
          value.event.kind === "call_ended",
      ),
    ).toMatchObject({
      type: "voice.event",
      event: { kind: "call_ended", reason: "remote_hangup" },
    });
    expect(await messages.next((value) => value.type === "session.ended")).toMatchObject({
      type: "session.ended",
      reason: "remote_hangup",
    });
  });
});

function managedRemoteHangupAgent(
  telephony: RemoteVoiceAgentFactoryContext["telephony"],
): VoiceAgent {
  const stt: SpeechToTextProvider = {
    name: "remote-test-stt",
    kind: "stt",
    version: "1.0.0",
    capabilities: MANAGED_TEST_CAPABILITIES,
    async open() {
      return {
        events: new AsyncQueue<TranscriptEvent>(),
        async sendAudio() {},
        async commit() {},
        async close() {},
      };
    },
  };
  const llm: LLMProvider = {
    name: "remote-test-llm",
    kind: "llm",
    version: "1.0.0",
    capabilities: MANAGED_TEST_CAPABILITIES,
    async complete() {
      throw new Error("no transcript should reach the LLM");
    },
  };
  const tts: TextToSpeechProvider = {
    name: "remote-test-tts",
    kind: "tts",
    version: "1.0.0",
    capabilities: MANAGED_TEST_CAPABILITIES,
    async synthesize() {
      throw new Error("no response should reach TTS");
    },
  };
  return createVoiceAgent({
    prompt: "Remote session lifecycle test",
    providers: { telephony, stt, llm, tts },
  });
}

interface FakeAgentOptions {
  readonly toolSignal?: AbortSignal;
  readonly afterToolError?: () => Promise<void>;
}

function fakeAgent(
  tools: RemoteVoiceAgentFactoryContext["tools"],
  testOptions: FakeAgentOptions = {},
): VoiceAgent {
  return {
    id: "agent_remote_test",
    name: "Remote test agent",
    prompt: "test",
    providers: { telephony: "web-client-audio", stt: "fake", llm: "fake", tts: "fake" },
    async start(options: VoiceAgentRunOptions): Promise<VoiceAgentSession> {
      const callHandle =
        typeof options.callHandle === "function"
          ? await options.callHandle({
              sessionId: "session_remote_test" as SessionId,
              call: options.call!,
              channel: "web_audio",
              signal: options.signal ?? new AbortController().signal,
            })
          : options.callHandle;
      const run = {
        async *[Symbol.asyncIterator]() {
          for await (const event of callHandle.events) {
            if (event.type === "media.stream.started") break;
          }
          const definition = tools[0];
          if (!definition) throw new Error("expected a remote tool definition");
          let output: unknown;
          try {
            output = await definition.execute(
              { email: "person@example.com" },
              toolExecutionContext(options.memoryUserId, testOptions.toolSignal),
            );
          } catch (error) {
            await testOptions.afterToolError?.();
            throw error;
          }
          yield {
            kind: "tool_result",
            toolCallId: "tool_remote_test",
            output,
            latencyMs: 1,
          } as const;
          yield { kind: "call_ended", reason: "completed", totalTurns: 1 } as const;
        },
      };
      return {
        sessionId: "session_remote_test" as SessionId,
        run: run as unknown as VoiceAgentSession["run"],
      };
    },
    async run() {
      throw new Error("not used by the remote service");
    },
    async stop() {},
    async healthCheck() {
      return { ok: true };
    },
  };
}

function failingAgent(): VoiceAgent {
  return {
    id: "agent_remote_failure",
    name: "Remote failure test agent",
    prompt: "test",
    providers: { telephony: "web-client-audio", stt: "fake", llm: "fake", tts: "fake" },
    async start(options: VoiceAgentRunOptions): Promise<VoiceAgentSession> {
      const callHandle =
        typeof options.callHandle === "function"
          ? await options.callHandle({
              sessionId: "session_remote_failure" as SessionId,
              call: options.call!,
              channel: "web_audio",
              signal: options.signal ?? new AbortController().signal,
            })
          : options.callHandle;
      if (!callHandle) throw new Error("expected a remote call handle");
      const run = {
        async *[Symbol.asyncIterator]() {
          for await (const event of callHandle.events) {
            if (event.type === "media.stream.started") break;
          }
          await callHandle.close("error");
          yield {
            kind: "error",
            error: {
              code: "turn.failed",
              category: "internal",
              message: "runtime failed",
              retriable: false,
            },
            recoverable: false,
          } as const;
          yield { kind: "call_ended", reason: "failed", totalTurns: 0 } as const;
        },
      };
      return {
        sessionId: "session_remote_failure" as SessionId,
        run: run as unknown as VoiceAgentSession["run"],
      };
    },
    async run() {
      throw new Error("not used by the remote service");
    },
    async stop() {},
    async healthCheck() {
      return { ok: true };
    },
  };
}

interface CompletingAgentOptions {
  readonly event?: VoiceEvent;
  readonly onFinalizationStarted?: () => void;
  readonly waitForFinalization?: () => Promise<void>;
}

function createDeeplyNestedValue(): unknown {
  let value: unknown = null;
  for (let depth = 0; depth < 600; depth += 1) value = [value];
  return value;
}

function completingAgent(
  onFinalized: (error?: unknown) => void,
  completionOptions: CompletingAgentOptions = {},
): VoiceAgent {
  return {
    id: "agent_remote_complete",
    name: "Remote completion test agent",
    prompt: "test",
    providers: { telephony: "web-client-audio", stt: "fake", llm: "fake", tts: "fake" },
    async start(options: VoiceAgentRunOptions): Promise<VoiceAgentSession> {
      const callHandle =
        typeof options.callHandle === "function"
          ? await options.callHandle({
              sessionId: "session_remote_complete" as SessionId,
              call: options.call!,
              channel: "web_audio",
              signal: options.signal ?? new AbortController().signal,
            })
          : options.callHandle;
      if (!callHandle) throw new Error("expected a remote call handle");
      const run = {
        async *[Symbol.asyncIterator]() {
          try {
            for await (const event of callHandle.events) {
              if (event.type === "media.stream.started") break;
            }
            if (completionOptions.event) yield completionOptions.event;
            yield { kind: "call_ended", reason: "completed", totalTurns: 1 } as const;
          } finally {
            try {
              completionOptions.onFinalizationStarted?.();
              await completionOptions.waitForFinalization?.();
              await callHandle.close("completed");
              onFinalized();
            } catch (error) {
              onFinalized(error);
              throw error;
            }
          }
        },
      };
      return {
        sessionId: "session_remote_complete" as SessionId,
        run: run as unknown as VoiceAgentSession["run"],
      };
    },
    async run() {
      throw new Error("not used by the remote service");
    },
    async stop() {},
    async healthCheck() {
      return { ok: true };
    },
  };
}

function toolExecutionContext(
  memoryUserId: UserId | undefined,
  signal: AbortSignal = new AbortController().signal,
): ToolExecutionContext {
  return {
    sessionId: "session_remote_test" as SessionId,
    turnId: "turn_remote_test" as ToolExecutionContext["turnId"],
    toolCallId: "tool_remote_test" as ToolExecutionContext["toolCallId"],
    attempt: 1,
    signal,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    ...(memoryUserId ? { tenant: { userId: memoryUserId } } : {}),
  };
}

async function opened(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return;
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
}

class SocketMessages {
  readonly #messages: Array<Record<string, unknown>> = [];
  readonly #waiters: Array<{
    readonly predicate: (value: Record<string, unknown>) => boolean;
    readonly resolve: (value: Record<string, unknown>) => void;
    readonly reject: (error: Error) => void;
    readonly timer: ReturnType<typeof setTimeout>;
  }> = [];

  constructor(socket: WebSocket) {
    socket.on("message", (data, isBinary) => {
      if (isBinary) return;
      let value: unknown;
      try {
        value = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!isRecord(value)) return;
      const message = value;
      const index = this.#waiters.findIndex((waiter) => waiter.predicate(message));
      if (index < 0) {
        this.#messages.push(message);
        return;
      }
      const [waiter] = this.#waiters.splice(index, 1);
      if (!waiter) return;
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    });
  }

  next(predicate: (value: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
    const index = this.#messages.findIndex(predicate);
    if (index >= 0) return Promise.resolve(this.#messages.splice(index, 1)[0]!);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.#waiters.findIndex((waiter) => waiter.resolve === resolve);
        if (index >= 0) this.#waiters.splice(index, 1);
        reject(
          new Error(
            `timed out waiting for the WebSocket message; buffered: ${JSON.stringify(this.#messages)}`,
          ),
        );
      }, 3_000);
      this.#waiters.push({ predicate, resolve, reject, timer });
    });
  }

  has(predicate: (value: Record<string, unknown>) => boolean): boolean {
    return this.#messages.some(predicate);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
