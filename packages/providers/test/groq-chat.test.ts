import { afterEach, describe, expect, it, vi } from "vitest";

import type { SessionId, Timestamp, ToolDefinition, TurnId } from "@tvic/core";
import { PROVIDER_ERROR_CODES, PROVIDER_NAMES } from "@tvic/core";

import {
  GROQ_RESPONSE_HEADERS_TIMEOUT_MS,
  GROQ_RESPONSE_IDLE_TIMEOUT_MS,
  GroqChatLlmProvider,
  createGroqChatLlmProvider,
} from "../src/groq-chat.js";
import { PROVIDER_CATALOG } from "../src/catalog.js";
import { MAX_PROVIDER_LLM_OUTPUT_CHARS } from "../src/common.js";

const fixedClock = {
  now(): Timestamp {
    return "2026-09-15T00:00:00.000Z" as Timestamp;
  },
};

const requestBase = {
  sessionId: "session_groq" as SessionId,
  turnId: "turn_groq" as TurnId,
  model: PROVIDER_CATALOG.groq.defaultModel,
  messages: [{ role: "user" as const, content: "Check availability." }],
  stream: true,
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
});

describe("Groq Chat Completions provider", () => {
  it("rejects an unsupported model before making a network request", async () => {
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return new Response("unexpected", { status: 500 });
    };
    const provider = new GroqChatLlmProvider({ apiKey: "secret", clock: fixedClock });

    await expect(
      provider.complete({ ...requestBase, model: "not-a-real-model" }),
    ).rejects.toMatchObject({
      category: "validation",
      code: "provider.model_unsupported",
      provider: PROVIDER_NAMES.groq,
    });
    expect(fetchCalls).toBe(0);
  });

  it("allows an explicitly opted-in custom model", async () => {
    globalThis.fetch = async () =>
      new Response(sseStream([{ choices: [{ delta: { content: "ok" } }] }]), { status: 200 });
    const provider = new GroqChatLlmProvider({
      apiKey: "secret",
      clock: fixedClock,
      allowUnknownModel: true,
    });

    const completion = await provider.complete({ ...requestBase, model: "self-hosted-model" });
    const events = [];
    for await (const event of completion.events) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: "llm.completed", text: "ok" });
  });

  it("declares the native SSE/tool contract and uses the Groq endpoint", () => {
    const provider = createGroqChatLlmProvider({ apiKey: "secret", clock: fixedClock });
    expect(provider).toBeInstanceOf(GroqChatLlmProvider);
    expect(provider.name).toBe(PROVIDER_NAMES.groq);
    expect(provider.capabilities).toMatchObject({
      streaming: { input: false, output: true, native: true },
      transports: ["http", "sse"],
      models: PROVIDER_CATALOG.groq.models,
      tools: { functionCalling: true, parallelCalls: false },
    });
  });

  it("maps chat messages, tools, safety, and streamed text/tool calls", async () => {
    const bodies: Array<Readonly<Record<string, unknown>>> = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body: unknown = JSON.parse(String(init?.body ?? "{}"));
      if (typeof body === "object" && body !== null && !Array.isArray(body)) {
        bodies.push(body as Readonly<Record<string, unknown>>);
      }
      return new Response(
        sseStream([
          {
            id: "chat-1",
            choices: [{ index: 0, delta: { role: "assistant", content: "Checking." } }],
          },
          {
            id: "chat-1",
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_1",
                      type: "function",
                      function: { name: "check_availability", arguments: '{"partySize":2' },
                    },
                  ],
                },
              },
            ],
          },
          {
            id: "chat-1",
            choices: [
              {
                index: 0,
                finish_reason: "tool_calls",
                delta: { tool_calls: [{ index: 0, function: { arguments: "}" } }] },
              },
            ],
          },
          { id: "chat-1", choices: [], usage: { prompt_tokens: 11, completion_tokens: 7 } },
        ]),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );
    };
    globalThis.fetch = fetchImpl;

    const tool = {
      id: "tool_availability",
      name: "check_availability",
      description: "Check a table.",
      version: "1.0.0",
      inputSchema: { type: "object", properties: { partySize: { type: "number" } } },
      outputSchema: { type: "object" },
      timeout: { mode: "fixed", timeoutMs: 1_000 },
      retry: { maxAttempts: 1 },
      idempotency: { mode: "none" },
      async execute() {
        return { available: true };
      },
    } as unknown as ToolDefinition;
    const provider = new GroqChatLlmProvider({ apiKey: "secret", clock: fixedClock });
    const completion = await provider.complete({
      ...requestBase,
      messages: [{ role: "system", content: "You are concise." }, ...requestBase.messages],
      tools: [tool],
      maxTokens: 88,
      safetyIdentifier: "hashed-user",
      metadata: { ignored: "by-groq" },
    });
    const events = [];
    for await (const event of completion.events) events.push(event);

    expect(events.map((event) => event.type)).toEqual([
      "llm.started",
      "llm.token",
      "llm.tool_call",
      "llm.completed",
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "llm.completed",
      text: "Checking.",
      usage: { inputTokens: 11, outputTokens: 7 },
    });
    expect(events.find((event) => event.type === "llm.tool_call")).toMatchObject({
      call: { callRef: "call_1", toolName: "check_availability", input: { partySize: 2 } },
    });

    const body = bodies[0]!;
    expect(body.model).toBe(PROVIDER_CATALOG.groq.defaultModel);
    expect(body.stream).toBe(true);
    expect(body.max_completion_tokens).toBe(88);
    expect(body.user).toBe("hashed-user");
    expect(body).not.toHaveProperty("metadata");
    expect(body).not.toHaveProperty("input");
    expect(body.messages).toEqual([
      { role: "system", content: "You are concise." },
      { role: "user", content: "Check availability." },
    ]);
    expect(body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "check_availability",
          description: "Check a table.",
          parameters: { type: "object", properties: { partySize: { type: "number" } } },
        },
      },
    ]);
    expect(body.parallel_tool_calls).toBe(false);
  });

  it("preserves an assistant tool-call envelope on continuation requests", async () => {
    let body: Readonly<Record<string, unknown>> | undefined;
    globalThis.fetch = async (_input, init) => {
      body = JSON.parse(String(init?.body ?? "{}")) as Readonly<Record<string, unknown>>;
      return new Response(sseStream([{ choices: [{ delta: { content: "Done." } }] }]), {
        status: 200,
      });
    };
    const provider = new GroqChatLlmProvider({ apiKey: "secret", clock: fixedClock });
    const completion = await provider.complete({
      ...requestBase,
      messages: [
        { role: "user", content: "Book it." },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { callRef: "call_1", toolName: "check_availability" as never, input: { partySize: 2 } },
          ],
        },
        {
          role: "tool",
          content: '{"available":true}',
          toolCallRef: "call_1",
          toolName: "check_availability" as never,
        },
      ],
    });
    for await (const _event of completion.events) {
      // Drain the provider stream.
    }

    expect(body?.messages).toEqual([
      { role: "user", content: "Book it." },
      {
        role: "assistant",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "check_availability", arguments: '{"partySize":2}' },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_1",
        name: "check_availability",
        content: '{"available":true}',
      },
    ]);
  });

  it("normalizes HTTP and protocol failures without returning response bodies", async () => {
    globalThis.fetch = async () => new Response("secret upstream body", { status: 401 });
    const provider = new GroqChatLlmProvider({ apiKey: "secret", clock: fixedClock });
    const completion = await provider.complete(requestBase);
    const httpEvents = [];
    for await (const event of completion.events) httpEvents.push(event);
    expect(httpEvents.at(-1)).toMatchObject({
      type: "llm.failed",
      error: {
        code: PROVIDER_ERROR_CODES.groqHttp,
        retriable: false,
      },
    });
    expect(JSON.stringify(httpEvents)).not.toContain("secret upstream body");

    globalThis.fetch = async () => new Response("data: {bad json}\n\n", { status: 200 });
    const malformed = await provider.complete(requestBase);
    const protocolEvents = [];
    for await (const event of malformed.events) protocolEvents.push(event);
    expect(protocolEvents.at(-1)).toMatchObject({
      type: "llm.failed",
      error: { code: PROVIDER_ERROR_CODES.groqProtocol, retriable: false },
    });
  });

  it("classifies streamed authentication, validation, and transient failures", async () => {
    const cases = [
      { code: "invalid_api_key", retriable: false, classification: "auth" },
      { code: "invalid_request_error", retriable: false, classification: "invalid_request" },
      { code: "rate_limit_exceeded", retriable: true, classification: "rate_limited" },
      { code: "internal_server_error", retriable: true, classification: "upstream" },
    ] as const;
    for (const testCase of cases) {
      globalThis.fetch = async () =>
        new Response(sseStream([{ error: { code: testCase.code, message: "secret detail" } }]), {
          status: 200,
        });
      const provider = new GroqChatLlmProvider({ apiKey: "secret", clock: fixedClock });
      const completion = await provider.complete(requestBase);
      const events = [];
      for await (const event of completion.events) events.push(event);
      expect(events.at(-1)).toMatchObject({
        type: "llm.failed",
        error: {
          code: PROVIDER_ERROR_CODES.groqResponseFailed,
          retriable: testCase.retriable,
          metadata: { providerCode: testCase.code, classification: testCase.classification },
        },
      });
      expect(JSON.stringify(events)).not.toContain("secret detail");
    }
  });

  it("fails closed on incomplete choices, truncated streams, and malformed tool arguments", async () => {
    globalThis.fetch = async () => new Response("data: [DONE]\r\n\r\n", { status: 200 });
    const provider = new GroqChatLlmProvider({ apiKey: "secret", clock: fixedClock });
    const noChoice = await provider.complete(requestBase);
    const noChoiceEvents = [];
    for await (const event of noChoice.events) noChoiceEvents.push(event);
    expect(noChoiceEvents.at(-1)).toMatchObject({
      type: "llm.failed",
      error: { code: PROVIDER_ERROR_CODES.groqProtocol },
    });

    globalThis.fetch = async () =>
      new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\r\n\r\n', {
        status: 200,
      });
    const truncated = await provider.complete(requestBase);
    const truncatedEvents = [];
    for await (const event of truncated.events) truncatedEvents.push(event);
    expect(truncatedEvents.at(-1)).toMatchObject({
      type: "llm.failed",
      error: { code: PROVIDER_ERROR_CODES.groqProtocol },
    });

    globalThis.fetch = async () =>
      new Response(
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"lookup","arguments":"{\\"x\\":"}}]}}]}\r\n\r\ndata: [DONE]\r\n\r\n',
        { status: 200 },
      );
    const malformedArguments = await provider.complete(requestBase);
    const malformedEvents = [];
    for await (const event of malformedArguments.events) malformedEvents.push(event);
    expect(malformedEvents.at(-1)).toMatchObject({
      type: "llm.failed",
      error: { code: PROVIDER_ERROR_CODES.groqProtocol },
    });

    globalThis.fetch = async () =>
      new Response(
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"lookup","arguments":123}}]}}]}\r\n\r\ndata: [DONE]\r\n\r\n',
        { status: 200 },
      );
    const invalidArgumentType = await provider.complete(requestBase);
    const invalidArgumentEvents = [];
    for await (const event of invalidArgumentType.events) invalidArgumentEvents.push(event);
    expect(invalidArgumentEvents.at(-1)).toMatchObject({
      type: "llm.failed",
      error: { code: PROVIDER_ERROR_CODES.groqProtocol },
    });
    expect(invalidArgumentEvents.some((event) => event.type === "llm.tool_call")).toBe(false);
  });

  it("fails closed on malformed nested response fields", async () => {
    const malformedPayloads: readonly Readonly<Record<string, unknown>>[] = [
      { choices: [{ delta: { content: 42 } }] },
      { choices: [{ delta: { tool_calls: {} } }] },
      { choices: [{ delta: "not-an-object" }] },
    ];

    for (const payload of malformedPayloads) {
      globalThis.fetch = async () => new Response(sseStream([payload]), { status: 200 });
      const provider = new GroqChatLlmProvider({ apiKey: "secret", clock: fixedClock });
      const completion = await provider.complete(requestBase);
      const events = [];
      for await (const event of completion.events) events.push(event);
      expect(events.at(-1)).toMatchObject({
        type: "llm.failed",
        error: { code: PROVIDER_ERROR_CODES.groqProtocol },
      });
    }
  });

  it("fails a response body that stays idle after headers", async () => {
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'),
            );
          },
        }),
        { status: 200 },
      );
    const provider = new GroqChatLlmProvider({ apiKey: "secret", clock: fixedClock });
    const completion = await provider.complete(requestBase);
    const eventsPromise = (async () => {
      const events = [];
      for await (const event of completion.events) events.push(event);
      return events;
    })();

    await vi.advanceTimersByTimeAsync(GROQ_RESPONSE_IDLE_TIMEOUT_MS + 1);
    const events = await eventsPromise;
    expect(events.at(-1)).toMatchObject({
      type: "llm.failed",
      error: {
        code: PROVIDER_ERROR_CODES.groqChat,
        category: "timeout",
        provider: PROVIDER_NAMES.groq,
        metadata: { phase: "response_body", idleTimeoutMs: GROQ_RESPONSE_IDLE_TIMEOUT_MS },
      },
    });
  });

  it("classifies a response-header timeout instead of collapsing it into a generic provider error", async () => {
    vi.useFakeTimers();
    globalThis.fetch = async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason ?? new Error("aborted")),
          { once: true },
        );
      });
    const provider = new GroqChatLlmProvider({ apiKey: "secret", clock: fixedClock });
    const completion = await provider.complete(requestBase);
    const eventsPromise = (async () => {
      const events = [];
      for await (const event of completion.events) events.push(event);
      return events;
    })();

    await vi.advanceTimersByTimeAsync(GROQ_RESPONSE_HEADERS_TIMEOUT_MS + 1);
    const events = await eventsPromise;
    expect(events.at(-1)).toMatchObject({
      type: "llm.failed",
      error: {
        code: PROVIDER_ERROR_CODES.groqChat,
        category: "timeout",
        provider: PROVIDER_NAMES.groq,
        metadata: { phase: "response_headers", timeoutMs: GROQ_RESPONSE_HEADERS_TIMEOUT_MS },
      },
    });
  });

  it("fails when streamed visible output exceeds its lifetime bound", async () => {
    globalThis.fetch = async () =>
      new Response(
        sseStream(
          Array.from({ length: 5 }, () => ({
            choices: [{ delta: { content: "x".repeat(900_000) } }],
          })),
        ),
        { status: 200 },
      );
    const provider = new GroqChatLlmProvider({ apiKey: "secret", clock: fixedClock });
    const completion = await provider.complete(requestBase);
    const events = [];
    for await (const event of completion.events) events.push(event);
    expect(events.at(-1)).toMatchObject({
      type: "llm.failed",
      error: {
        code: "provider.stream_buffer_overflow",
        provider: PROVIDER_NAMES.groq,
      },
    });
    expect(MAX_PROVIDER_LLM_OUTPUT_CHARS).toBeLessThan(5 * 900_000);
  });
});

function sseStream(
  events: readonly Readonly<Record<string, unknown>>[],
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const source = `${events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join("")}data: [DONE]\r\n\r\n`;
  return new ReadableStream({
    start(controller) {
      const midpoint = Math.max(1, Math.floor(source.length / 2));
      controller.enqueue(encoder.encode(source.slice(0, midpoint)));
      controller.enqueue(encoder.encode(source.slice(midpoint)));
      controller.close();
    },
  });
}
