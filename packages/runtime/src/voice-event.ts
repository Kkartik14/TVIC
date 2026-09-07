import type { NormalizedError, SessionId, ToolCallId, TurnId } from "@tvic/core";
import type { PipelineVoiceLoopResult } from "./pipeline-loop.js";

/**
 * Public-facing event emitted by a voice pipeline run. A discriminated
 * union of 8 kinds so consumers can `switch (event.kind)` without
 * runtime guessing.
 *
 * The shape is intentionally a *friendlier* view than the internal
 * `MediaEvent`. The runtime's `MediaEvent` includes IDs, sequence
 * numbers, and provider metadata; `VoiceEvent` strips those and exposes
 * the same data in a UX-friendly form.
 */
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
      readonly latencyMs: number;
    }
  | { readonly kind: "error"; readonly error: NormalizedError; readonly recoverable: boolean }
  | {
      readonly kind: "call_ended";
      readonly reason: "completed" | "cancelled" | "failed" | "remote_hangup";
      readonly totalTurns: number;
    };

/**
 * The result of starting a `PipelineVoiceLoop`. Dual-protocol: awaits
 * to a final `PipelineVoiceLoopResult` AND iterates the per-event
 * stream.
 *
 * Implementation note: the class implements both `PromiseLike<PipelineVoiceLoopResult>`
 * and `AsyncIterable<VoiceEvent>`. Awaiting and iterating are independent
 * — the run starts on the first await/iteration. Subsequent awaits share
 * the same promise. Iteration drains buffered events before completing.
 */
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

  /**
   * The session ID this result is for. Exposed for consumer convenience
   * (e.g., logging).
   */
  readonly sessionId: SessionId;
}

/**
 * Backward-compat alias. Older callers reference `PipelineVoiceLoopResultLike`
 * directly; new callers should use `PipelineVoiceLoopResult`.
 *
 * @deprecated Use `PipelineVoiceLoopResult` from `@tvic/runtime` instead.
 */
export type PipelineVoiceLoopResultLike = PipelineVoiceLoopResult;
