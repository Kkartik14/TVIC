import type { ProviderEventId, SessionId, TurnId } from "../ids.js";
import type { Timestamp } from "../timestamp.js";

interface SttEventBase {
  readonly id: ProviderEventId;
  readonly direction: "input";
  readonly sessionId: SessionId;
  readonly turnId?: TurnId;
  readonly sequence: number;
  readonly provider: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type TranscriptSegmentEventType = "stt.partial" | "stt.final";

/** A provider-defined transcript segment; final means immutable, not end-of-turn. */
export interface TranscriptSegmentEvent extends SttEventBase {
  readonly type: TranscriptSegmentEventType;
  readonly text: string;
  readonly segmentId?: string;
  readonly revision?: number;
  readonly confidence?: number;
  readonly language?: string;
  readonly startTimestamp: Timestamp;
  readonly endTimestamp: Timestamp;
  /** Offset into the provider audio stream, independent from wall-clock receipt time. */
  readonly audioStartMs?: number;
  readonly audioEndMs?: number;
}

export type TranscriptEndpointReason = "provider" | "silence" | "manual" | "max_duration";

/** The STT/turn detector decided buffered final segments form a complete user turn. */
export interface TranscriptEndpointEvent extends SttEventBase {
  readonly type: "stt.endpoint";
  readonly reason: TranscriptEndpointReason;
  readonly timestamp: Timestamp;
  readonly audioOffsetMs?: number;
  readonly confidence?: number;
}

export interface TranscriptSpeechStartedEvent extends SttEventBase {
  readonly type: "stt.speech.started";
  readonly timestamp: Timestamp;
  readonly audioOffsetMs?: number;
}

export type TranscriptEvent =
  | TranscriptSegmentEvent
  | TranscriptEndpointEvent
  | TranscriptSpeechStartedEvent;

export type TranscriptEventType = TranscriptEvent["type"];

export function isTranscriptSegmentEvent(event: TranscriptEvent): event is TranscriptSegmentEvent {
  return event.type === "stt.partial" || event.type === "stt.final";
}
