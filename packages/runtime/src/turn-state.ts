import type {
  SessionId,
  TtsAlignmentUnit,
  Turn,
  TurnCancellationReason,
  TurnId,
  TurnLatency,
} from "@tvic/core";

export interface TurnLatencyRecord {
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly sequence: number;
  readonly status: "completed" | "cancelled" | "failed";
  readonly latency: TurnLatency;
}

/** Timing captured at the moment an utterance is committed into a turn. */
export interface UtteranceTiming {
  readonly endpointAtMs: number;
  readonly listenedMs?: number;
  readonly endpointMs?: number;
}

export interface MutableTurnLatency {
  listenedMs?: number;
  endpointMs?: number;
  interruptionTailMs?: number;
  firstTokenMs?: number;
  firstAudioMs?: number;
  toolMs?: number;
  totalMs?: number;
}

export interface ActiveTurnControl {
  readonly turnId: Turn["id"];
  readonly abort: AbortController;
  readonly startedAtMs: number;
  interruptedAtMs: number | null;
  interruptionTailMs: number | null;
  interruptionCheckpoint?: Promise<boolean>;
  cancelReason: TurnCancellationReason;
  outputFramesSent: number;
  speaking: boolean;
  outputDelivered: boolean;
  alignedTokens: string[];
  alignedUnit: TtsAlignmentUnit | null;
  alignedCharacterStarts: Set<number>;
  alignedDurationMs: number;
  lastFlushSequence: number | null;
}

export function reportTurnLatency(
  report: ((record: TurnLatencyRecord) => void) | undefined,
  sessionId: SessionId,
  turn: Turn,
  status: TurnLatencyRecord["status"],
  latency: MutableTurnLatency,
): void {
  if (!report) return;
  try {
    report({
      sessionId,
      turnId: turn.id,
      sequence: turn.sequence,
      status,
      latency: { ...latency },
    });
  } catch {
    // Observation must never alter live execution.
  }
}
