import type {
  Agent,
  LlmInlineToolCall,
  LlmMessage,
  ToolDefinition,
  TranscriptEvent,
} from "@tvic/core";
import { isTranscriptSegmentEvent } from "@tvic/core";

export interface ConversationPolicyOptions {
  readonly agent: Agent;
}

export class ConversationPolicy {
  readonly #agent: Agent;
  readonly #history: LlmMessage[] = [];
  #finalTranscriptBuffer = "";

  constructor(options: ConversationPolicyOptions) {
    this.#agent = options.agent;
    this.#history.push({ role: "system", content: options.agent.instructions });
  }

  acceptTranscript(event: TranscriptEvent): string | null {
    if (!isTranscriptSegmentEvent(event)) {
      return event.type === "stt.endpoint" ? this.flushBufferedTranscript() : null;
    }

    if (event.type === "stt.partial") {
      return null;
    }

    this.#finalTranscriptBuffer = `${this.#finalTranscriptBuffer} ${event.text}`.trim();
    return null;
  }

  get hasBufferedTranscript(): boolean {
    return this.#finalTranscriptBuffer.length > 0;
  }

  /** Commits buffered final segments for an endpoint, timeout, or stream shutdown. */
  flushBufferedTranscript(): string | null {
    const transcript = this.#finalTranscriptBuffer;
    this.#finalTranscriptBuffer = "";
    return transcript || null;
  }

  messagesForTranscript(transcript: string): readonly LlmMessage[] {
    return [...this.#history, { role: "user", content: transcript }];
  }

  messagesForToolContinuation(
    messages: readonly LlmMessage[],
    assistantText: string,
    toolMessages: readonly LlmMessage[],
  ): readonly LlmMessage[] {
    return [...messages, { role: "assistant", content: assistantText }, ...toolMessages];
  }

  recordTurn(transcript: string, assistantText: string): void {
    this.#history.push({ role: "user", content: transcript });
    this.#history.push({ role: "assistant", content: assistantText });
  }

  recordInterruptedTurn(transcript: string, assistantText: string): void {
    this.#history.push({ role: "user", content: transcript });
    this.#history.push({
      role: "assistant",
      content: assistantText
        ? `[Response interrupted before completion; some of this may not have been heard.] ${assistantText}`
        : "[Response interrupted before completion.]",
    });
  }

  findTool(call: LlmInlineToolCall): ToolDefinition | null {
    return this.#agent.tools.find((tool) => tool.name === call.toolName) ?? null;
  }
}
