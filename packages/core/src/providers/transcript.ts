import type { ProviderEventId, SessionId, TraceId, TurnId } from "../ids.js";
import type { Timestamp } from "../timestamp.js";

export type TranscriptEventType = "stt.partial" | "stt.final";

export interface TranscriptEvent {
  readonly id: ProviderEventId;
  readonly type: TranscriptEventType;
  readonly direction: "input";
  readonly sessionId: SessionId;
  readonly turnId?: TurnId;
  readonly traceId?: TraceId;
  readonly sequence: number;
  readonly provider: string;
  readonly text: string;
  readonly confidence?: number;
  readonly language?: string;
  readonly startTimestamp: Timestamp;
  readonly endTimestamp: Timestamp;
  readonly metadata?: Readonly<Record<string, unknown>>;
}
