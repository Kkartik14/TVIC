import type { NormalizedError } from "../errors.js";
import type { ProviderEventId, SessionId, ToolName, TraceId, TurnId } from "../ids.js";
import type { Provider } from "../provider.js";
import type { Timestamp } from "../timestamp.js";
import type { ToolDefinition } from "../tool.js";

export type LlmMessageRole = "system" | "user" | "assistant" | "tool";

export interface LlmMessage {
  readonly role: LlmMessageRole;
  readonly content: string;
  readonly toolCallRef?: string;
  readonly toolName?: ToolName;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface LlmInlineToolCall {
  readonly callRef: string;
  readonly toolName: ToolName;
  readonly input: unknown;
}

export interface LlmCompletionRequest {
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly model: string;
  readonly messages: readonly LlmMessage[];
  readonly tools?: readonly ToolDefinition[];
  readonly stream: boolean;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Aborts startup (e.g. a connect timeout) so a stalled request does not leak. */
  readonly signal?: AbortSignal;
}

interface LlmEventBase {
  readonly id: ProviderEventId;
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly traceId?: TraceId;
  readonly sequence: number;
  readonly provider: string;
  readonly timestamp: Timestamp;
}

export interface LlmUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens?: number;
}

export type LlmStreamEvent =
  | (LlmEventBase & { readonly type: "llm.started"; readonly model: string })
  | (LlmEventBase & { readonly type: "llm.token"; readonly text: string })
  | (LlmEventBase & { readonly type: "llm.tool_call"; readonly call: LlmInlineToolCall })
  | (LlmEventBase & {
      readonly type: "llm.completed";
      readonly text: string;
      readonly toolCalls: readonly LlmInlineToolCall[];
      readonly usage?: LlmUsage;
    })
  | (LlmEventBase & { readonly type: "llm.failed"; readonly error: NormalizedError });

export interface LlmCompletion {
  readonly events: AsyncIterable<LlmStreamEvent>;
  cancel(): Promise<void>;
}

export interface LLMProvider extends Provider {
  readonly kind: "llm";
  complete(request: LlmCompletionRequest): Promise<LlmCompletion>;
}
