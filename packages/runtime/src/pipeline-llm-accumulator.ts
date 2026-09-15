import { stableStringify } from "@tvic/tools";
import type { LlmInlineToolCall } from "@tvic/core";

import {
  MAX_RUNTIME_LLM_EVENTS,
  MAX_RUNTIME_LLM_OUTPUT_BYTES,
  MAX_RUNTIME_LLM_TOOL_ARGUMENT_BYTES,
  MAX_RUNTIME_LLM_TOOL_CALLS,
  MAX_RUNTIME_LLM_TOOL_FIELD_BYTES,
} from "./pipeline-constants.js";
import { runtimeResourceLimitError, utf8ByteLength } from "./pipeline-resource-limits.js";

export const REDACTED_TOOL_INPUT = Object.freeze({
  $tvic: "input_unavailable",
  reason: "not_serializable",
});

export interface PipelineLlmAccumulatorOptions {
  readonly cancel: () => Promise<void>;
  readonly onText?: (text: string) => Promise<void>;
}

/**
 * Provider-neutral LLM stream state. It owns lifetime accounting so a custom
 * adapter cannot bypass the same text, event, or tool-call bounds as a built-in
 * provider. Tool inputs are copied from bounded JSON rather than retaining an
 * arbitrary provider object graph.
 */
export class PipelineLlmAccumulator {
  readonly #cancel: () => Promise<void>;
  readonly #onText: ((text: string) => Promise<void>) | undefined;
  readonly #toolCalls: LlmInlineToolCall[] = [];
  readonly #seenToolRefs = new Set<string>();
  #text = "";
  #textBytes = 0;
  #eventCount = 0;
  #toolArgumentBytes = 0;

  constructor(options: PipelineLlmAccumulatorOptions) {
    this.#cancel = options.cancel;
    this.#onText = options.onText;
  }

  get text(): string {
    return this.#text;
  }

  get toolCalls(): readonly LlmInlineToolCall[] {
    return this.#toolCalls;
  }

  async recordEvent(): Promise<void> {
    this.#eventCount += 1;
    if (this.#eventCount > MAX_RUNTIME_LLM_EVENTS) {
      await this.#fail("LLM stream events", "events", MAX_RUNTIME_LLM_EVENTS);
    }
  }

  async appendText(value: string): Promise<void> {
    const bytes = utf8ByteLength(value);
    if (!Number.isSafeInteger(bytes) || this.#textBytes + bytes > MAX_RUNTIME_LLM_OUTPUT_BYTES) {
      await this.#fail("LLM output", "bytes", MAX_RUNTIME_LLM_OUTPUT_BYTES);
    }
    this.#text += value;
    this.#textBytes += bytes;
    await this.#onText?.(value);
  }

  async addToolCall(call: LlmInlineToolCall): Promise<void> {
    try {
      const callRefBytes = utf8ByteLength(call.callRef);
      const toolNameBytes = utf8ByteLength(call.toolName);
      if (
        !Number.isSafeInteger(callRefBytes) ||
        !Number.isSafeInteger(toolNameBytes) ||
        callRefBytes > MAX_RUNTIME_LLM_TOOL_FIELD_BYTES ||
        toolNameBytes > MAX_RUNTIME_LLM_TOOL_FIELD_BYTES
      ) {
        throw runtimeResourceLimitError(
          "LLM tool-call fields",
          "bytes",
          MAX_RUNTIME_LLM_TOOL_FIELD_BYTES,
        );
      }
      const encodedInput = safeJsonStringify(call.input);
      const inputBytes = utf8ByteLength(encodedInput);
      if (
        !Number.isSafeInteger(inputBytes) ||
        inputBytes > MAX_RUNTIME_LLM_TOOL_ARGUMENT_BYTES ||
        this.#toolArgumentBytes + inputBytes > MAX_RUNTIME_LLM_TOOL_ARGUMENT_BYTES
      ) {
        throw runtimeResourceLimitError(
          "LLM tool arguments",
          "bytes",
          MAX_RUNTIME_LLM_TOOL_ARGUMENT_BYTES,
        );
      }
      if (this.#seenToolRefs.has(call.callRef)) return;
      if (this.#toolCalls.length >= MAX_RUNTIME_LLM_TOOL_CALLS) {
        throw runtimeResourceLimitError("LLM tool calls", "calls", MAX_RUNTIME_LLM_TOOL_CALLS);
      }

      let boundedInput: unknown;
      try {
        stableStringify(call.input);
        boundedInput = JSON.parse(encodedInput) as unknown;
      } catch {
        boundedInput = REDACTED_TOOL_INPUT;
      }
      this.#toolCalls.push({ ...call, input: boundedInput });
      this.#seenToolRefs.add(call.callRef);
      this.#toolArgumentBytes += inputBytes;
    } catch (error) {
      await this.#cancel();
      throw error;
    }
  }

  async complete(text: string, calls: readonly LlmInlineToolCall[]): Promise<void> {
    if (utf8ByteLength(text) > MAX_RUNTIME_LLM_OUTPUT_BYTES) {
      await this.#fail("LLM completion text", "bytes", MAX_RUNTIME_LLM_OUTPUT_BYTES);
    }
    if (!this.#text && text) await this.appendText(text);
    for (const call of calls) await this.addToolCall(call);
  }

  async #fail(resource: string, unit: "bytes" | "events" | "calls", limit: number): Promise<never> {
    await this.#cancel();
    throw runtimeResourceLimitError(resource, unit, limit);
  }
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return JSON.stringify(REDACTED_TOOL_INPUT);
  }
}
