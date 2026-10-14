import type {
  NormalizedError,
  SessionId,
  ToolCallId,
  TurnId,
  TurnOutputDelivery,
} from "@tvic/core";
import type { PipelineVoiceLoopResult } from "./pipeline-loop.js";

export type VoiceEvent =
  | {
      readonly kind: "transcript_delta";
      readonly text: string;
      readonly turnId: TurnId;
      readonly isFinal: boolean;
    }
  | {
      readonly kind: "audio_output";
      readonly bytes: Uint8Array;
      readonly turnId: TurnId;
      readonly sequence: number;
    }
  | { readonly kind: "turn_started"; readonly turnId: TurnId; readonly turnSequence: number }
  | {
      readonly kind: "turn_completed";
      readonly turnId: TurnId;
      readonly status: "completed" | "cancelled" | "failed";
      readonly latencyMs: number;
      readonly delivery?: TurnOutputDelivery;
    }
  | {
      readonly kind: "tool_call";
      readonly toolCallId: ToolCallId;
      readonly toolName: string;
      readonly input: unknown;
    }
  | {
      readonly kind: "tool_result";
      readonly toolCallId: ToolCallId;
      readonly output: unknown;
      readonly status: "succeeded" | "failed" | "timed_out" | "cancelled";
      readonly error?: Pick<NormalizedError, "code" | "message">;
      readonly recoveryPolicy?: "do_not_replay";
      readonly latencyMs: number;
    }
  | { readonly kind: "error"; readonly error: NormalizedError; readonly recoverable: boolean }
  | {
      readonly kind: "call_ended";
      readonly reason: "completed" | "cancelled" | "failed" | "remote_hangup";
      readonly totalTurns: number;
    };

export interface DualProtocolResult extends PromiseLike<PipelineVoiceLoopResult> {
  then<TResult1 = PipelineVoiceLoopResult, TResult2 = never>(
    onfulfilled?:
      | ((value: PipelineVoiceLoopResult) => TResult1 | PromiseLike<TResult1>)
      | null
      | undefined,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null | undefined,
  ): PromiseLike<TResult1 | TResult2>;

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null | undefined,
  ): PromiseLike<PipelineVoiceLoopResult | TResult>;

  finally(onfinally?: (() => void) | null | undefined): PromiseLike<PipelineVoiceLoopResult>;

  [Symbol.asyncIterator](): AsyncIterator<VoiceEvent>;

  readonly sessionId: SessionId;
}

/**
 * Backward-compat alias. Older callers reference `PipelineVoiceLoopResultLike`
 * directly; new callers should use `PipelineVoiceLoopResult`.
 *
 * @deprecated Use `PipelineVoiceLoopResult` from `@tvic/runtime` instead.
 */
export type PipelineVoiceLoopResultLike = PipelineVoiceLoopResult;
