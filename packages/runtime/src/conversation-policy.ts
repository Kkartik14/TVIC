import type {
  Agent,
  LlmInlineToolCall,
  LlmMessage,
  ToolDefinition,
  TranscriptEvent,
} from "@tvic/core";

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
    if (event.type === "stt.partial") {
      return null;
    }

    this.#finalTranscriptBuffer = `${this.#finalTranscriptBuffer} ${event.text}`.trim();
    // TODO(endpointing-v1): replace this provider speech-final gate with the planned
    // VAD tentative EOU + STT final confirmation + max-wait fallback state machine.
    if (event.metadata?.speechFinal === false) {
      return null;
    }

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

  findTool(call: LlmInlineToolCall): ToolDefinition | null {
    return this.#agent.tools.find((tool) => tool.name === call.toolName) ?? null;
  }
}
