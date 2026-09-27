import type {
  LLMProvider,
  LlmCompletion,
  LlmCompletionRequest,
  LlmInlineToolCall,
  LlmMessage,
  LlmStreamEvent,
  LlmUsage,
  NormalizedError,
  ProviderCapabilities,
  ProviderEventId,
  ToolDefinition,
  ToolName,
} from "@tvic/core";
import {
  PROVIDER_ERROR_CODES,
  PROVIDER_NAMES,
  counterIdGenerator,
  timeoutError,
  TvicThrowableError,
} from "@tvic/core";
import { AsyncQueue } from "@tvic/media";

import { PROVIDER_CATALOG } from "./catalog.js";
import {
  SystemProviderClock,
  normalizeProviderError,
  providerEventQueueOverflow,
  providerError,
  assertSupportedModel,
  parseJsonObject,
  MAX_PROVIDER_LLM_OUTPUT_CHARS,
  MAX_PROVIDER_LLM_TOOL_ARGUMENT_CHARS,
  MAX_PROVIDER_LLM_TOOL_CALLS,
  MAX_PROVIDER_LLM_TOOL_FIELD_CHARS,
  type ProviderClock,
} from "./common.js";
import {
  classifiedProviderError,
  readBoundedProviderErrorBody,
} from "./provider-error-classifier.js";

export interface GroqChatLlmProviderOptions {
  readonly apiKey: string;
  readonly url?: string;
  /** Allows an explicitly configured compatible endpoint/model outside the dated catalog. */
  readonly allowUnknownModel?: boolean;
  readonly clock?: ProviderClock;
}

/** Max time to await response headers before aborting the fetch. */
export const GROQ_RESPONSE_HEADERS_TIMEOUT_MS = 10_000;
/** Max time between readable response-body chunks before aborting the stream. */
export const GROQ_RESPONSE_IDLE_TIMEOUT_MS = 30_000;
const MAX_SSE_FRAME_BYTES = 1_048_576;
const SSE_DONE = Symbol("groq.sse.done");

type GroqStreamEvent = Readonly<Record<string, unknown>>;
type GroqSseItem = GroqStreamEvent | typeof SSE_DONE;
type GroqReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>;

const GROQ_CAPABILITIES = {
  streaming: { input: false, output: true, native: true },
  cancellation: { request: true, output: true, buffer: false, truncation: false },
  transports: ["http", "sse"],
  models: PROVIDER_CATALOG.groq.models,
  // The reference models currently have local tool calling but not parallel
  // tool calling. The runtime executes calls in order, so advertise the
  // conservative capability that is true for every dated catalog model.
  tools: { functionCalling: true, parallelCalls: false },
} satisfies ProviderCapabilities;

export class GroqChatLlmProvider implements LLMProvider {
  readonly name = PROVIDER_NAMES.groq;
  readonly kind = "llm";
  readonly version = "0.1.0";
  readonly capabilities = GROQ_CAPABILITIES;

  readonly #apiKey: string;
  readonly #url: string;
  readonly #allowUnknownModel: boolean;
  readonly #clock: ProviderClock;

  constructor(options: GroqChatLlmProviderOptions) {
    this.#apiKey = options.apiKey;
    this.#url = options.url ?? "https://api.groq.com/openai/v1/chat/completions";
    this.#allowUnknownModel = options.allowUnknownModel ?? false;
    this.#clock = options.clock ?? new SystemProviderClock();
  }

  async complete(request: LlmCompletionRequest): Promise<LlmCompletion> {
    assertSupportedModel(
      PROVIDER_NAMES.groq,
      PROVIDER_CATALOG.groq.models,
      request.model,
      this.#allowUnknownModel,
    );
    const controller = new AbortController();
    let removeCallerAbort: (() => void) | undefined;
    if (request.signal) {
      if (request.signal.aborted) {
        controller.abort();
      } else {
        const onAbort = (): void => controller.abort();
        request.signal.addEventListener("abort", onAbort, { once: true });
        removeCallerAbort = () => request.signal?.removeEventListener("abort", onAbort);
      }
    }

    const events = new AsyncQueue<LlmStreamEvent>({
      onOverflow: () => {
        const error = providerEventQueueOverflow(PROVIDER_NAMES.groq);
        controller.abort(error);
        return error;
      },
    });
    const ids = counterIdGenerator<ProviderEventId>("groq_event");
    const startedAt = this.#clock.now();
    let sequence = 1;
    let outputText = "";
    let usage: LlmUsage | undefined;
    let terminal = false;
    const toolCalls = new Map<number, MutableToolCall>();
    const allowedToolNames = new Set(request.tools?.map((tool) => tool.name) ?? []);
    let toolArgumentChars = 0;
    let sawChoice = false;

    const pushEvent = (event: LlmStreamEvent): boolean => {
      const accepted = events.push(event);
      if (!accepted) {
        terminal = true;
        if (!events.isClosed) {
          const error = providerEventQueueOverflow(PROVIDER_NAMES.groq);
          controller.abort(error);
          events.fail(error);
        }
      }
      return accepted;
    };

    const pushSequencedEvent = (event: Omit<LlmStreamEvent, "id" | "sequence">): boolean => {
      const accepted = pushEvent({
        ...event,
        id: ids.next(),
        sequence,
      } as LlmStreamEvent);
      if (accepted) sequence += 1;
      return accepted;
    };

    if (
      !pushSequencedEvent({
        type: "llm.started",
        sessionId: request.sessionId,
        turnId: request.turnId,
        provider: PROVIDER_NAMES.groq,
        timestamp: startedAt,
        model: request.model,
      } as Omit<LlmStreamEvent, "id" | "sequence">)
    ) {
      removeCallerAbort?.();
      return { events, cancel: async () => undefined };
    }

    const emitFailure = (error: NormalizedError): void => {
      if (terminal || events.isClosed) return;
      terminal = true;
      pushEvent({
        id: ids.next(),
        type: "llm.failed",
        sessionId: request.sessionId,
        turnId: request.turnId,
        sequence,
        provider: PROVIDER_NAMES.groq,
        timestamp: this.#clock.now(),
        error,
      });
      if (!events.isClosed) sequence += 1;
      controller.abort(error);
      events.close();
    };

    const emitCompleted = (): void => {
      if (terminal) return;
      const calls = [...toolCalls.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, call]) => freezeToolCall(call));
      for (const call of calls) {
        if (
          !pushSequencedEvent({
            type: "llm.tool_call",
            sessionId: request.sessionId,
            turnId: request.turnId,
            provider: PROVIDER_NAMES.groq,
            timestamp: this.#clock.now(),
            call,
          } as Omit<LlmStreamEvent, "id" | "sequence">)
        ) {
          return;
        }
      }
      if (
        !pushSequencedEvent({
          type: "llm.completed",
          sessionId: request.sessionId,
          turnId: request.turnId,
          provider: PROVIDER_NAMES.groq,
          timestamp: this.#clock.now(),
          text: outputText,
          toolCalls: calls,
          ...(usage ? { usage } : {}),
        } as Omit<LlmStreamEvent, "id" | "sequence">)
      ) {
        return;
      }
      terminal = true;
      events.close();
    };

    let cancelRequested = false;
    const streamDone = this.#stream(request, controller)
      .then(async (response) => {
        let sawDone = false;
        for await (const item of parseSse(response, controller)) {
          if (item === SSE_DONE) {
            sawDone = true;
            if (!sawChoice) {
              throw protocolFailure("Groq stream completed without a response choice");
            }
            emitCompleted();
            break;
          }
          if (terminal) break;

          if (item.error !== undefined && item.error !== null) {
            emitFailure(groqStreamingError(item.error));
            break;
          }

          const rootUsage = usageFrom(item.usage);
          if (rootUsage) usage = rootUsage;
          const choices = arrayField(item, "choices");
          if (choices === null) {
            throw protocolFailure("Groq response omitted its choices array");
          }
          if (choices.length === 0) continue;
          if (choices.length !== 1) {
            throw protocolFailure("Groq returned an unexpected number of response choices");
          }
          const choice = objectField(choices[0], "");
          if (!choice) throw protocolFailure("Groq returned a malformed response choice");
          sawChoice = true;
          const delta = objectField(choice, "delta");
          if (!delta) throw protocolFailure("Groq returned a response choice without a delta");
          const text = stringField(delta, "content");
          if (delta.content !== undefined && text === null) {
            throw protocolFailure("Groq returned a non-text response delta");
          }
          if (text) {
            if (outputText.length + text.length > MAX_PROVIDER_LLM_OUTPUT_CHARS) {
              throw providerEventQueueOverflow(PROVIDER_NAMES.groq);
            }
            if (
              !pushSequencedEvent({
                type: "llm.token",
                sessionId: request.sessionId,
                turnId: request.turnId,
                provider: PROVIDER_NAMES.groq,
                timestamp: this.#clock.now(),
                text,
              } as Omit<LlmStreamEvent, "id" | "sequence">)
            ) {
              break;
            }
            outputText += text;
          }
          const toolCallDeltas = arrayField(delta, "tool_calls");
          if (delta.tool_calls !== undefined && toolCallDeltas === null) {
            throw protocolFailure("Groq returned malformed tool call deltas");
          }
          for (const value of toolCallDeltas ?? []) {
            toolArgumentChars += absorbToolCall(
              toolCalls,
              value,
              toolArgumentChars,
              allowedToolNames,
            );
          }
        }
        if (!sawDone && !terminal) {
          throw protocolFailure("Groq stream ended before its completion marker");
        }
      })
      .catch((error: unknown) => {
        if (cancelRequested || terminal || events.isClosed) return;
        emitFailure(
          normalizeProviderError(error, {
            code: PROVIDER_ERROR_CODES.groqChat,
            provider: PROVIDER_NAMES.groq,
          }),
        );
      })
      .finally(() => removeCallerAbort?.());

    return {
      events,
      async cancel() {
        cancelRequested = true;
        events.close();
        controller.abort();
        await streamDone.catch(() => undefined);
        removeCallerAbort?.();
      },
    };
  }

  async #stream(
    request: LlmCompletionRequest,
    controller: AbortController,
  ): Promise<ReadableStream<Uint8Array>> {
    const responseTimer = setTimeout(() => {
      controller.abort(
        TvicThrowableError.from(
          timeoutError(
            PROVIDER_ERROR_CODES.groqChat,
            `Groq response headers timed out after ${GROQ_RESPONSE_HEADERS_TIMEOUT_MS}ms`,
            {
              provider: PROVIDER_NAMES.groq,
              metadata: {
                phase: "response_headers",
                timeoutMs: GROQ_RESPONSE_HEADERS_TIMEOUT_MS,
              },
            },
          ),
        ),
      );
    }, GROQ_RESPONSE_HEADERS_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(this.#url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(toGroqRequest(request)),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted && controller.signal.reason !== undefined) {
        throw controller.signal.reason;
      }
      throw error;
    } finally {
      clearTimeout(responseTimer);
    }

    if (!response.ok || !response.body) {
      const body = await readBoundedProviderErrorBody(response);
      const parsed = parseJsonObject(body.text);
      const error = objectField(parsed, "error") ?? parsed;
      throw TvicThrowableError.from(
        classifiedProviderError(
          PROVIDER_NAMES.groq,
          `Groq request failed with ${response.status}`,
          {
            status: response.status,
            providerCode: error?.code,
            providerType: error?.type,
            message: error?.message,
            bodyTruncated: body.truncated,
            bodyMalformed: body.text.trim().length > 0 && parsed === null,
          },
        ),
      );
    }
    return response.body;
  }
}

export function createGroqChatLlmProvider(
  options: GroqChatLlmProviderOptions,
): GroqChatLlmProvider {
  return new GroqChatLlmProvider(options);
}

interface MutableToolCall {
  callRef: string;
  toolName: ToolName;
  argumentsJson: string;
}

function absorbToolCall(
  calls: Map<number, MutableToolCall>,
  value: unknown,
  existingArgumentChars: number,
  allowedToolNames: ReadonlySet<string>,
): number {
  const item = objectField(value, "");
  if (!item) throw protocolFailure("Groq returned a malformed tool call delta");
  const index = numberField(item, "index");
  if (index === null || !Number.isSafeInteger(index) || index < 0) {
    throw protocolFailure("Groq returned a tool call without a valid index");
  }
  if (!calls.has(index) && calls.size >= MAX_PROVIDER_LLM_TOOL_CALLS) {
    throw providerEventQueueOverflow(PROVIDER_NAMES.groq);
  }
  const functionValue = objectField(item, "function");
  const rawFunction = item.function;
  if (
    rawFunction !== undefined &&
    (typeof rawFunction !== "object" || rawFunction === null || Array.isArray(rawFunction))
  ) {
    throw protocolFailure("Groq returned a malformed tool function");
  }
  const call = calls.get(index) ?? {
    callRef: "",
    toolName: "" as ToolName,
    argumentsJson: "",
  };
  const callRef = stringField(item, "id");
  const toolName = stringField(functionValue, "name");
  const rawArguments = functionValue?.arguments;
  if (rawArguments !== undefined && typeof rawArguments !== "string") {
    throw protocolFailure("Groq returned a non-string tool call arguments field");
  }
  const argumentsJson = rawArguments ?? null;
  if (
    (callRef !== null && callRef.length > MAX_PROVIDER_LLM_TOOL_FIELD_CHARS) ||
    (toolName !== null && toolName.length > MAX_PROVIDER_LLM_TOOL_FIELD_CHARS)
  ) {
    throw providerEventQueueOverflow(PROVIDER_NAMES.groq);
  }
  const appendedArgumentChars = argumentsJson?.length ?? 0;
  if (existingArgumentChars + appendedArgumentChars > MAX_PROVIDER_LLM_TOOL_ARGUMENT_CHARS) {
    throw providerEventQueueOverflow(PROVIDER_NAMES.groq);
  }
  if (callRef && call.callRef && call.callRef !== callRef) {
    throw protocolFailure("Groq returned conflicting tool call identity");
  }
  if (toolName && call.toolName && call.toolName !== toolName) {
    throw protocolFailure("Groq returned conflicting tool name identity");
  }
  if (toolName && !allowedToolNames.has(toolName)) {
    throw protocolFailure("Groq returned a tool call for an unknown tool");
  }
  if (callRef) call.callRef = callRef;
  if (toolName) call.toolName = toolName as ToolName;
  if (argumentsJson) call.argumentsJson += argumentsJson;
  calls.set(index, call);
  return appendedArgumentChars;
}

function freezeToolCall(call: MutableToolCall): LlmInlineToolCall {
  if (!call.callRef || !call.toolName) {
    throw protocolFailure("Groq returned an incomplete tool call");
  }
  return {
    callRef: call.callRef,
    toolName: call.toolName,
    input: parseToolArguments(call.argumentsJson),
  };
}

function parseToolArguments(value: string): unknown {
  if (!value) return {};
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw protocolFailure("Groq returned malformed tool call arguments");
  }
}

function toGroqRequest(request: LlmCompletionRequest): Readonly<Record<string, unknown>> {
  return {
    model: request.model,
    messages: request.messages.map(toGroqMessage),
    ...(request.tools && request.tools.length > 0
      ? {
          tools: request.tools.map(toGroqTool),
          parallel_tool_calls: false,
        }
      : {}),
    stream: true,
    ...(typeof request.temperature === "number" ? { temperature: request.temperature } : {}),
    ...(typeof request.maxTokens === "number" ? { max_completion_tokens: request.maxTokens } : {}),
    ...(request.safetyIdentifier ? { user: request.safetyIdentifier } : {}),
  };
}

function toGroqMessage(message: LlmMessage): Readonly<Record<string, unknown>> {
  if (message.role === "tool") {
    if (!message.toolCallRef) {
      throw protocolFailure("Groq tool result is missing its tool call reference");
    }
    return {
      role: "tool",
      tool_call_id: message.toolCallRef,
      ...(message.toolName ? { name: message.toolName } : {}),
      content: message.content,
    };
  }
  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "assistant",
      ...(message.content ? { content: message.content } : {}),
      tool_calls: message.toolCalls.map((call) => ({
        id: call.callRef,
        type: "function",
        function: {
          name: call.toolName,
          arguments: encodeToolArguments(call.input),
        },
      })),
    };
  }
  return { role: message.role, content: message.content };
}

function toGroqTool(tool: ToolDefinition): Readonly<Record<string, unknown>> {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}

function encodeToolArguments(input: unknown): string {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input) ?? "{}";
  } catch {
    return "{}";
  }
}

async function* parseSse(
  stream: ReadableStream<Uint8Array>,
  controller: AbortController,
): AsyncIterable<GroqSseItem> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await readWithIdleTimeout(reader, controller);
      buffer += decoder.decode(value, { stream: !done });
      while (true) {
        const boundary = /\r?\n\r?\n/u.exec(buffer);
        if (!boundary || boundary.index === undefined) break;
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        if (Buffer.byteLength(frame, "utf8") > MAX_SSE_FRAME_BYTES) {
          throw protocolFailure("Groq SSE frame exceeded the bounded parser limit");
        }
        const parsed = parseSseFrame(frame);
        if (parsed !== null) yield parsed;
      }
      if (Buffer.byteLength(buffer, "utf8") > MAX_SSE_FRAME_BYTES) {
        throw protocolFailure("Groq SSE frame exceeded the bounded parser limit");
      }
      if (done) break;
    }

    if (buffer.trim()) {
      if (Buffer.byteLength(buffer, "utf8") > MAX_SSE_FRAME_BYTES) {
        throw protocolFailure("Groq SSE frame exceeded the bounded parser limit");
      }
      const parsed = parseSseFrame(buffer);
      if (parsed !== null) yield parsed;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  controller: AbortController,
): Promise<GroqReadResult> {
  if (controller.signal.aborted) {
    return Promise.reject(controller.signal.reason ?? new Error("Groq response was cancelled"));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      controller.signal.removeEventListener("abort", onAbort);
    };
    const resolveOnce = (result: GroqReadResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const rejectOnce = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = (): void => {
      rejectOnce(controller.signal.reason ?? new Error("Groq response was cancelled"));
    };
    timer = setTimeout(() => {
      const error = TvicThrowableError.from(
        timeoutError(
          PROVIDER_ERROR_CODES.groqChat,
          `Groq response body was idle for ${GROQ_RESPONSE_IDLE_TIMEOUT_MS}ms`,
          {
            provider: PROVIDER_NAMES.groq,
            metadata: {
              phase: "response_body",
              idleTimeoutMs: GROQ_RESPONSE_IDLE_TIMEOUT_MS,
            },
          },
        ),
      );
      rejectOnce(error);
      controller.abort(error);
      void reader.cancel().catch(() => undefined);
    }, GROQ_RESPONSE_IDLE_TIMEOUT_MS);
    controller.signal.addEventListener("abort", onAbort, { once: true });
    void reader.read().then(resolveOnce, rejectOnce);
  });
}

function parseSseFrame(frame: string): GroqSseItem | null {
  const data = frame
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n");
  if (!data) return null;
  if (data === "[DONE]") return SSE_DONE;
  try {
    const parsed: unknown = JSON.parse(data);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as GroqStreamEvent;
  } catch {
    throw protocolFailure("Groq returned malformed SSE JSON");
  }
}

function protocolFailure(message: string): TvicThrowableError {
  return TvicThrowableError.from(
    providerError(PROVIDER_ERROR_CODES.groqProtocol, message, {
      provider: PROVIDER_NAMES.groq,
      retriable: false,
    }),
  );
}

function groqStreamingError(value: unknown) {
  const error = objectField(value, "");
  return classifiedProviderError(PROVIDER_NAMES.groq, "Groq returned an error while streaming", {
    providerCode: error?.code,
    providerType: error?.type,
    message: error?.message,
  });
}

function usageFrom(value: unknown): LlmUsage | undefined {
  const usage = objectField(value, "");
  if (!usage) return undefined;
  const inputTokens = numberField(usage, "prompt_tokens") ?? numberField(usage, "input_tokens");
  const outputTokens =
    numberField(usage, "completion_tokens") ?? numberField(usage, "output_tokens");
  if (
    inputTokens === null ||
    outputTokens === null ||
    !Number.isSafeInteger(inputTokens) ||
    !Number.isSafeInteger(outputTokens) ||
    inputTokens < 0 ||
    outputTokens < 0
  ) {
    return undefined;
  }
  const promptDetails = objectField(usage, "prompt_tokens_details");
  const inputDetails = objectField(usage, "input_tokens_details");
  const cachedTokens =
    numberField(promptDetails, "cached_tokens") ?? numberField(inputDetails, "cached_tokens");
  return {
    inputTokens,
    outputTokens,
    ...(cachedTokens !== null && Number.isSafeInteger(cachedTokens) && cachedTokens >= 0
      ? { cachedTokens }
      : {}),
  };
}

function objectField(value: unknown, key: string): Readonly<Record<string, unknown>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  if (!key) return value as Readonly<Record<string, unknown>>;
  const field = (value as Readonly<Record<string, unknown>>)[key];
  return typeof field === "object" && field !== null && !Array.isArray(field)
    ? (field as Readonly<Record<string, unknown>>)
    : null;
}

function arrayField(value: unknown, key: string): readonly unknown[] | null {
  const object = objectField(value, "");
  const field = object?.[key];
  return Array.isArray(field) ? field : null;
}

function stringField(value: Readonly<Record<string, unknown>> | null, key: string): string | null {
  const field = value?.[key];
  return typeof field === "string" ? field : null;
}

function numberField(value: Readonly<Record<string, unknown>> | null, key: string): number | null {
  const field = value?.[key];
  return typeof field === "number" && Number.isFinite(field) ? field : null;
}
