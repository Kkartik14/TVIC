import type {
  LLMProvider,
  LlmCompletion,
  LlmCompletionRequest,
  LlmInlineToolCall,
  LlmMessage,
  LlmStreamEvent,
  ProviderCapabilities,
  ProviderEventId,
  ToolDefinition,
  ToolName,
} from "@tvic/core";
import {
  PROVIDER_ERROR_CODES,
  PROVIDER_NAMES,
  counterIdGenerator,
  TvicThrowableError,
} from "@tvic/core";
import { AsyncQueue } from "@tvic/media";

import { PROVIDER_CATALOG } from "./catalog.js";
import {
  SystemProviderClock,
  normalizeProviderError,
  parseJsonObject,
  providerEventQueueOverflow,
  providerError,
  type ProviderClock,
} from "./common.js";

export interface OpenAiResponsesLlmProviderOptions {
  readonly apiKey: string;
  readonly url?: string;
  readonly clock?: ProviderClock;
}

/** Max time to await response headers before aborting the fetch. */
const RESPONSE_TIMEOUT_MS = 10_000;

type OpenAiStreamEvent = Readonly<Record<string, unknown>> & { readonly type?: string };

export class OpenAiResponsesLlmProvider implements LLMProvider {
  readonly name = PROVIDER_NAMES.openaiResponses;
  readonly kind = "llm";
  readonly version = "0.1.0";
  readonly capabilities = {
    streaming: { input: false, output: true, native: true },
    cancellation: { request: true, output: true, buffer: false, truncation: false },
    transports: ["http", "sse"],
    models: PROVIDER_CATALOG.openaiResponses.models,
    tools: { functionCalling: true, parallelCalls: true },
  } satisfies ProviderCapabilities;

  readonly #apiKey: string;
  readonly #url: string;
  readonly #clock: ProviderClock;

  constructor(options: OpenAiResponsesLlmProviderOptions) {
    this.#apiKey = options.apiKey;
    this.#url = options.url ?? "https://api.openai.com/v1/responses";
    this.#clock = options.clock ?? new SystemProviderClock();
  }

  async complete(request: LlmCompletionRequest): Promise<LlmCompletion> {
    const controller = new AbortController();
    // A caller-supplied signal (startup timeout / barge-in) aborts the fetch too.
    let removeRequestAbortListener = (): void => undefined;
    if (request.signal) {
      if (request.signal.aborted) {
        controller.abort();
      } else {
        const onAbort = (): void => controller.abort();
        request.signal.addEventListener("abort", onAbort, { once: true });
        removeRequestAbortListener = () => request.signal?.removeEventListener("abort", onAbort);
      }
    }
    const events = new AsyncQueue<LlmStreamEvent>();
    const ids = counterIdGenerator<ProviderEventId>("openai_event");
    const startedAt = this.#clock.now();
    let sequence = 1;
    let outputText = "";
    const toolCalls = new Map<number, MutableToolCall>();
    let eventQueueFailed = false;
    let terminalSeen = false;
    const pushEvent = (event: LlmStreamEvent): boolean => {
      if (eventQueueFailed) return false;
      if (events.push(event)) return true;
      eventQueueFailed = true;
      const failure = TvicThrowableError.from(
        providerEventQueueOverflow(PROVIDER_NAMES.openaiResponses),
      );
      events.fail(failure);
      controller.abort();
      removeRequestAbortListener();
      return false;
    };
    const closeEvents = (): void => {
      removeRequestAbortListener();
      events.close();
    };

    pushEvent({
      id: ids.next(),
      type: "llm.started",
      sessionId: request.sessionId,
      turnId: request.turnId,
      sequence,
      provider: PROVIDER_NAMES.openaiResponses,
      timestamp: startedAt,
      model: request.model,
    });
    sequence += 1;

    void this.#stream(request, controller)
      .then(async (response) => {
        for await (const event of parseSse(response)) {
          const type = event.type;
          if (type === "response.output_text.delta" && typeof event.delta === "string") {
            outputText += event.delta;
            if (
              !pushEvent({
                id: ids.next(),
                type: "llm.token",
                sessionId: request.sessionId,
                turnId: request.turnId,
                sequence,
                provider: PROVIDER_NAMES.openaiResponses,
                timestamp: this.#clock.now(),
                text: event.delta,
              })
            )
              return;
            sequence += 1;
            continue;
          }

          if (type === "response.output_item.added") {
            const outputIndex = numberField(event, "output_index");
            const item = objectField(event, "item");
            if (typeof outputIndex === "number" && item?.type === "function_call") {
              toolCalls.set(outputIndex, {
                callRef:
                  stringField(item, "call_id") ?? stringField(item, "id") ?? `${outputIndex}`,
                toolName: (stringField(item, "name") ?? "") as ToolName,
                argumentsJson: stringField(item, "arguments") ?? "",
              });
            }
            continue;
          }

          if (type === "response.function_call_arguments.delta") {
            const outputIndex = numberField(event, "output_index");
            const call = typeof outputIndex === "number" ? toolCalls.get(outputIndex) : undefined;
            if (call && typeof event.delta === "string") {
              call.argumentsJson += event.delta;
            }
            continue;
          }

          if (type === "response.function_call_arguments.done") {
            const outputIndex = numberField(event, "output_index");
            const call = typeof outputIndex === "number" ? toolCalls.get(outputIndex) : undefined;
            if (call) {
              const item = objectField(event, "item");
              call.argumentsJson =
                stringField(item, "arguments") ??
                stringField(event, "arguments") ??
                call.argumentsJson;
              if (
                !pushEvent({
                  id: ids.next(),
                  type: "llm.tool_call",
                  sessionId: request.sessionId,
                  turnId: request.turnId,
                  sequence,
                  provider: PROVIDER_NAMES.openaiResponses,
                  timestamp: this.#clock.now(),
                  call: freezeToolCall(call),
                })
              )
                return;
              sequence += 1;
            }
            continue;
          }

          if (type === "response.completed") {
            terminalSeen = true;
            if (
              !pushEvent({
                id: ids.next(),
                type: "llm.completed",
                sessionId: request.sessionId,
                turnId: request.turnId,
                sequence,
                provider: PROVIDER_NAMES.openaiResponses,
                timestamp: this.#clock.now(),
                text: outputText,
                toolCalls: [...toolCalls.values()].map(freezeToolCall),
              })
            )
              return;
            closeEvents();
            return;
          }

          if (type === "response.failed" || type === "error") {
            terminalSeen = true;
            if (
              !pushEvent({
                id: ids.next(),
                type: "llm.failed",
                sessionId: request.sessionId,
                turnId: request.turnId,
                sequence,
                provider: PROVIDER_NAMES.openaiResponses,
                timestamp: this.#clock.now(),
                error: providerError(
                  PROVIDER_ERROR_CODES.openaiResponseFailed,
                  JSON.stringify(event),
                  {
                    provider: PROVIDER_NAMES.openaiResponses,
                    retriable: true,
                  },
                ),
              })
            )
              return;
            closeEvents();
            return;
          }
        }

        if (!terminalSeen && !eventQueueFailed) {
          pushEvent({
            id: ids.next(),
            type: "llm.failed",
            sessionId: request.sessionId,
            turnId: request.turnId,
            sequence,
            provider: PROVIDER_NAMES.openaiResponses,
            timestamp: this.#clock.now(),
            error: providerError(
              PROVIDER_ERROR_CODES.openaiResponseFailed,
              "OpenAI response stream ended before a terminal event",
              {
                provider: PROVIDER_NAMES.openaiResponses,
                retriable: true,
                metadata: { reason: "unexpected_eof" },
              },
            ),
          });
        }
        closeEvents();
      })
      .catch((error: unknown) => {
        if (!terminalSeen && !eventQueueFailed) {
          pushEvent({
            id: ids.next(),
            type: "llm.failed",
            sessionId: request.sessionId,
            turnId: request.turnId,
            sequence,
            provider: PROVIDER_NAMES.openaiResponses,
            timestamp: this.#clock.now(),
            error: normalizeProviderError(error, {
              code: PROVIDER_ERROR_CODES.openaiResponses,
              provider: PROVIDER_NAMES.openaiResponses,
            }),
          });
        }
        closeEvents();
      });

    return {
      events,
      async cancel() {
        controller.abort();
        closeEvents();
      },
    };
  }

  async #stream(
    request: LlmCompletionRequest,
    controller: AbortController,
  ): Promise<ReadableStream<Uint8Array>> {
    // Bound the time-to-headers so an accepted-but-silent endpoint can't hang the
    // request open. The runtime also has a stream-stall timeout downstream.
    const responseTimer = setTimeout(() => controller.abort(), RESPONSE_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(this.#url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(toOpenAiRequest(request)),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(responseTimer);
    }

    if (!response.ok || !response.body) {
      throw TvicThrowableError.from(
        providerError(
          PROVIDER_ERROR_CODES.openaiHttp,
          `OpenAI request failed with ${response.status}`,
          {
            provider: PROVIDER_NAMES.openaiResponses,
            retriable: response.status >= 500 || response.status === 429,
          },
        ),
      );
    }

    return response.body;
  }
}

export function createOpenAiResponsesLlmProvider(
  options: OpenAiResponsesLlmProviderOptions,
): OpenAiResponsesLlmProvider {
  return new OpenAiResponsesLlmProvider(options);
}

interface MutableToolCall {
  callRef: string;
  toolName: ToolName;
  argumentsJson: string;
}

function freezeToolCall(call: MutableToolCall): LlmInlineToolCall {
  return {
    callRef: call.callRef,
    toolName: call.toolName,
    input: parseJsonObject(call.argumentsJson) ?? call.argumentsJson,
  };
}

function toOpenAiRequest(request: LlmCompletionRequest): Readonly<Record<string, unknown>> {
  const instructions = request.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");

  return {
    model: request.model,
    input: request.messages
      .filter((message) => message.role !== "system")
      .map(toOpenAiInputMessage),
    ...(instructions ? { instructions } : {}),
    ...(request.tools ? { tools: request.tools.map(toOpenAiTool) } : {}),
    stream: true,
    store: false,
    ...(typeof request.temperature === "number" ? { temperature: request.temperature } : {}),
    ...(typeof request.maxTokens === "number" ? { max_output_tokens: request.maxTokens } : {}),
    ...(request.safetyIdentifier ? { safety_identifier: request.safetyIdentifier } : {}),
    ...(request.metadata ? { metadata: request.metadata } : {}),
  };
}

function toOpenAiInputMessage(message: LlmMessage): Readonly<Record<string, unknown>> {
  if (message.role === "tool") {
    return {
      type: "function_call_output",
      call_id: message.toolCallRef,
      output: message.content,
    };
  }

  return {
    role: message.role,
    content: message.content,
  };
}

function toOpenAiTool(tool: ToolDefinition): Readonly<Record<string, unknown>> {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  };
}

async function* parseSse(stream: ReadableStream<Uint8Array>): AsyncIterable<OpenAiStreamEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let reachedEnd = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        reachedEnd = true;
        buffer += decoder.decode();
      } else {
        buffer += decoder.decode(value, { stream: true });
      }

      while (true) {
        const boundary = findSseBoundary(buffer);
        if (!boundary) break;
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const parsed = parseSseFrame(frame);
        if (parsed) yield parsed;
      }

      if (reachedEnd) {
        // Some proxies and test doubles close immediately after a final data
        // line without the optional blank separator. Process that final frame
        // instead of silently losing it.
        const parsed = parseSseFrame(buffer);
        if (parsed) yield parsed;
        break;
      }
    }
  } finally {
    if (!reachedEnd) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function findSseBoundary(
  buffer: string,
): { readonly index: number; readonly length: number } | null {
  const match = /\r\n\r\n|\n\n|\r\r/.exec(buffer);
  return match?.index === undefined ? null : { index: match.index, length: match[0].length };
}

function parseSseFrame(frame: string): OpenAiStreamEvent | null {
  const data = frame
    .split(/\r\n|\r|\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n")
    .trim();
  if (!data || data === "[DONE]") return null;
  return parseJsonObject(data) as OpenAiStreamEvent | null;
}

function objectField(
  object: Readonly<Record<string, unknown>> | null,
  key: string,
): Readonly<Record<string, unknown>> | null {
  const value = object?.[key];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function stringField(object: Readonly<Record<string, unknown>> | null, key: string): string | null {
  const value = object?.[key];
  return typeof value === "string" ? value : null;
}

function numberField(object: Readonly<Record<string, unknown>>, key: string): number | null {
  const value = object[key];
  return typeof value === "number" ? value : null;
}
