import type {
  Agent,
  AgentContextPolicy,
  LlmInlineToolCall,
  LlmMessage,
  PreCallContext,
  ToolDefinition,
  TranscriptEvent,
  Turn,
} from "@tvic/core";
import { isTranscriptSegmentEvent, validationError, TvicThrowableError } from "@tvic/core";

import { formatPreCallContextAsSystemBlock } from "./memory-loader.js";

export interface ConversationPolicyOptions {
  readonly agent: Agent;
  /**
   * Pre-call context loaded from the runtime before the call starts.
   * Contains both the caller's prior memory (rendered as
   * `<memory>...</memory>`) and any non-memory static context like
   * CRM records and feature flags (rendered as `<context>...</context>`).
   */
  readonly preCallContext?: PreCallContext;
  /** Optional per-instance override for the agent's live context byte limit. */
  readonly maxHistoryBytes?: number;
  /** Optional per-instance override for the agent's live context message limit. */
  readonly maxHistoryMessages?: number;
  /** Optional per-instance override for the pre-call context byte limit. */
  readonly maxPreCallBytes?: number;
}

const DEFAULT_MAX_HISTORY_BYTES = 32 * 1024;
const DEFAULT_MAX_HISTORY_MESSAGES = 32;
const DEFAULT_MAX_PRE_CALL_BYTES = 16 * 1024;

export class ConversationPolicy {
  readonly #agent: Agent;
  readonly #history: LlmMessage[] = [];
  readonly #preCallContext: PreCallContext | undefined;
  readonly #baseSystemInstruction: string;
  #systemInstructionOverride: string | undefined;
  #turnSystemInstruction: string | undefined;
  #staticVariables = new Map<string, string>();
  #finalTranscriptBuffer = "";
  readonly #maxHistoryBytes: number;
  readonly #maxHistoryMessages: number;
  readonly #maxPreCallBytes: number;

  constructor(options: ConversationPolicyOptions) {
    this.#agent = options.agent;
    this.#preCallContext = options.preCallContext;
    this.#baseSystemInstruction = options.agent.instructions;
    const contextPolicy: AgentContextPolicy = options.agent.contextPolicy ?? {};
    this.#maxHistoryBytes = positiveBudget(
      options.maxHistoryBytes ?? contextPolicy.maxHistoryBytes ?? DEFAULT_MAX_HISTORY_BYTES,
      "maxHistoryBytes",
      1,
    );
    this.#maxHistoryMessages = positiveBudget(
      options.maxHistoryMessages ??
        contextPolicy.maxHistoryMessages ??
        DEFAULT_MAX_HISTORY_MESSAGES,
      "maxHistoryMessages",
      2,
    );
    this.#maxPreCallBytes = positiveBudget(
      options.maxPreCallBytes ?? contextPolicy.maxPreCallBytes ?? DEFAULT_MAX_PRE_CALL_BYTES,
      "maxPreCallBytes",
      1,
    );
    this.#history.push({ role: "system", content: this.#renderSystemInstruction() });
    this.#trimHistory();
  }

  hydrateTurns(turns: readonly Turn[]): void {
    const orderedTurns = [...turns].sort(
      (a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id),
    );
    for (const turn of orderedTurns) {
      const transcript = turn.input.transcript;
      if (!transcript) continue;
      if (turn.status === "completed") {
        this.recordTurn(transcript, turn.output.text ?? "");
      } else if (turn.status === "cancelled" || turn.status === "interrupted") {
        this.recordInterruptedTurn(transcript, turn.output.text ?? "");
      }
    }
  }

  /**
   * Set the session-level system instruction. Pre-call context and variables
   * remain attached because the system message is rebuilt from canonical state.
   */
  replaceSystemInstruction(instruction: string): void {
    this.#systemInstructionOverride = instruction;
    this.#turnSystemInstruction = undefined;
    this.#refreshSystemInstruction();
  }

  /**
   * Set or clear a per-turn instruction. Clearing it restores the session-level
   * instruction without losing the tenant variables or pre-call context.
   */
  setTurnSystemInstruction(instruction: string | undefined): void {
    this.#turnSystemInstruction = instruction;
    this.#refreshSystemInstruction();
  }

  /**
   * Replace the static variables map. Values are substituted into `{{name}}`
   * placeholders and also rendered in a dedicated block so the model can see
   * variables that the base instruction did not reference explicitly.
   */
  setStaticVariables(variables: ReadonlyMap<string, string>): void {
    this.#staticVariables = new Map(variables);
    this.#refreshSystemInstruction();
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
    return this.#buildRequest({ role: "user", content: transcript }, this.#history.slice(1), []);
  }

  messagesForToolContinuation(
    messages: readonly LlmMessage[],
    assistantText: string,
    toolMessages: readonly LlmMessage[],
  ): readonly LlmMessage[] {
    const system = messages[0];
    const current = messages[messages.length - 1];
    if (!system || system.role !== "system" || !current || current.role !== "user") {
      throw TvicThrowableError.from(
        validationError(
          "llm.context_limit",
          "Cannot build a tool continuation without a system and current user message",
        ),
      );
    }
    return this.#buildRequest(current, messages.slice(1, -1), [
      { role: "assistant", content: assistantText },
      ...toolMessages,
    ]);
  }

  recordTurn(transcript: string, assistantText: string): void {
    this.#history.push({ role: "user", content: transcript });
    this.#history.push({ role: "assistant", content: assistantText });
    this.#trimHistory();
  }

  recordInterruptedTurn(transcript: string, assistantText: string): void {
    this.#history.push({ role: "user", content: transcript });
    this.#history.push({
      role: "assistant",
      content: assistantText
        ? `[Response interrupted before completion; some of this may not have been heard.] ${assistantText}`
        : "[Response interrupted before completion.]",
    });
    this.#trimHistory();
  }

  findTool(call: LlmInlineToolCall): ToolDefinition | null {
    return this.#agent.tools.find((tool) => tool.name === call.toolName) ?? null;
  }

  #refreshSystemInstruction(): void {
    this.#history[0] = { role: "system", content: this.#renderSystemInstruction() };
    this.#trimHistory();
  }

  #renderSystemInstruction(): string {
    const instruction =
      this.#turnSystemInstruction ?? this.#systemInstructionOverride ?? this.#baseSystemInstruction;
    const blocks = [substituteVariables(instruction, this.#staticVariables)];
    if (this.#staticVariables.size > 0) {
      const lines = ["<variables>"];
      for (const [key, value] of this.#staticVariables) {
        lines.push(`  ${key} = ${value}`);
      }
      lines.push("</variables>");
      blocks.push(lines.join("\n"));
    }
    if (this.#preCallContext) {
      blocks.push(formatPreCallContextAsSystemBlock(this.#preCallContext, this.#maxPreCallBytes));
    }
    return blocks.join("\n\n");
  }

  #buildRequest(
    current: LlmMessage,
    history: readonly LlmMessage[],
    active: readonly LlmMessage[],
  ): readonly LlmMessage[] {
    const system = this.#history[0];
    if (!system) {
      throw TvicThrowableError.from(
        validationError("llm.context_limit", "Conversation policy has no system instruction"),
      );
    }
    const required = [system, current, ...active];
    const requiredBytes = required.reduce((total, message) => total + messageBytes(message), 0);
    if (required.length > this.#maxHistoryMessages || requiredBytes > this.#maxHistoryBytes) {
      throw TvicThrowableError.from(
        contextLimitError(
          this.#maxHistoryBytes,
          this.#maxHistoryMessages,
          requiredBytes,
          required.length,
        ),
      );
    }

    const retained: LlmMessage[] = [];
    let bytes = requiredBytes;
    let messages = required.length;
    for (let index = history.length - 2; index >= 0; index -= 2) {
      const pair = history.slice(index, index + 2);
      if (pair.length !== 2) continue;
      const pairBytes = messageBytes(pair[0]!) + messageBytes(pair[1]!);
      if (
        messages + pair.length > this.#maxHistoryMessages ||
        bytes + pairBytes > this.#maxHistoryBytes
      ) {
        break;
      }
      retained.unshift(...pair);
      bytes += pairBytes;
      messages += pair.length;
    }
    return [system, ...retained, current, ...active];
  }

  #trimHistory(): void {
    const system = this.#history[0];
    if (!system) return;
    const retained: LlmMessage[] = [];
    let bytes = messageBytes(system);
    let messages = 1;
    for (let index = this.#history.length - 2; index >= 1; index -= 2) {
      const pair = this.#history.slice(index, index + 2);
      if (pair.length !== 2) continue;
      const pairBytes = messageBytes(pair[0]!) + messageBytes(pair[1]!);
      if (
        messages + pair.length > this.#maxHistoryMessages ||
        bytes + pairBytes > this.#maxHistoryBytes
      ) {
        break;
      }
      retained.unshift(...pair);
      bytes += pairBytes;
      messages += pair.length;
    }
    this.#history.splice(0, this.#history.length, system, ...retained);
  }
}

function substituteVariables(instruction: string, variables: ReadonlyMap<string, string>): string {
  return instruction.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (placeholder, key: string) => {
    return variables.get(key) ?? placeholder;
  });
}

function positiveBudget(value: number, name: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw TvicThrowableError.from(
      validationError(
        "llm.invalid_context_policy",
        `${name} must be a safe integer greater than or equal to ${minimum}: ${value}`,
      ),
    );
  }
  return value;
}

function messageBytes(message: LlmMessage): number {
  return new TextEncoder().encode(JSON.stringify(message)).byteLength;
}

function contextLimitError(
  maxBytes: number,
  maxMessages: number,
  requiredBytes: number,
  requiredMessages: number,
) {
  return validationError(
    "llm.context_limit",
    `LLM context exceeds the configured limit (${requiredBytes}/${maxBytes} bytes, ${requiredMessages}/${maxMessages} messages)`,
    {
      metadata: {
        maxBytes,
        maxMessages,
        requiredBytes,
        requiredMessages,
      },
    },
  );
}
