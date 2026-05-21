import type { AudioFormat, AudioPayload } from "./audio.js";
import type { MediaDirection } from "./direction.js";
import type { NormalizedError } from "./errors.js";
import type { CallId, CorrelationId, MediaEventId, SessionId, SpanId, TurnId } from "./ids.js";
import type { Timestamp } from "./timestamp.js";

export type MediaEventType =
  | "media.stream.started"
  | "media.stream.ended"
  | "media.audio.chunk"
  | "media.audio.committed"
  | "speech.started"
  | "speech.ended"
  | "silence.started"
  | "silence.ended"
  | "barge_in.detected"
  | "dtmf.received"
  | "media.error";

export const DTMF_DIGITS = [
  "0",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "*",
  "#",
  "A",
  "B",
  "C",
  "D",
] as const;

export type DtmfDigit = (typeof DTMF_DIGITS)[number];

const DTMF_DIGIT_SET: ReadonlySet<string> = new Set(DTMF_DIGITS);

export function isDtmfDigit(value: string | undefined): value is DtmfDigit {
  return value !== undefined && DTMF_DIGIT_SET.has(value);
}

interface MediaEventBase<T extends MediaEventType, D extends MediaDirection> {
  readonly id: MediaEventId;
  readonly type: T;
  readonly sessionId: SessionId;
  readonly callId?: CallId;
  readonly turnId?: TurnId;
  readonly sequence: number;
  readonly direction: D;
  readonly timestamp: Timestamp;
  readonly monotonicOffsetMs: number;
  readonly spanId?: SpanId;
  readonly correlationId?: CorrelationId;
  readonly provider?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type StreamEndReason = "completed" | "cancelled" | "remote_hangup" | "timeout" | "error";

export interface MediaStreamStartedEvent<
  D extends MediaDirection = MediaDirection,
> extends MediaEventBase<"media.stream.started", D> {
  readonly format: AudioFormat;
}

export interface MediaStreamEndedEvent<
  D extends MediaDirection = MediaDirection,
> extends MediaEventBase<"media.stream.ended", D> {
  readonly reason: StreamEndReason;
  readonly durationMs: number;
}

export interface MediaAudioChunkEvent<
  D extends MediaDirection = MediaDirection,
> extends MediaEventBase<"media.audio.chunk", D> {
  readonly audio: AudioPayload;
}

export interface MediaAudioCommittedEvent extends MediaEventBase<
  "media.audio.committed",
  "output"
> {
  readonly durationMs: number;
  readonly frameCount: number;
  readonly sequenceRange: readonly [number, number];
  readonly chunkIds: readonly MediaEventId[];
}

export interface SpeechStartedEvent extends MediaEventBase<"speech.started", "input"> {
  readonly confidence?: number;
}

export interface SpeechEndedEvent extends MediaEventBase<"speech.ended", "input"> {
  readonly durationMs: number;
  readonly confidence?: number;
}

export interface SilenceStartedEvent extends MediaEventBase<"silence.started", "input"> {
  readonly thresholdMs?: number;
}

export interface SilenceEndedEvent extends MediaEventBase<"silence.ended", "input"> {
  readonly durationMs: number;
}

export interface BargeInDetectedEvent extends MediaEventBase<"barge_in.detected", "input"> {
  readonly confidence: number;
  readonly againstTurnId?: TurnId;
}

export interface DtmfReceivedEvent extends MediaEventBase<"dtmf.received", "input"> {
  readonly digit: DtmfDigit;
  readonly durationMs?: number;
}

export interface MediaErrorEvent<D extends MediaDirection = MediaDirection> extends MediaEventBase<
  "media.error",
  D
> {
  readonly error: NormalizedError;
}

export type InputMediaEvent =
  | MediaStreamStartedEvent<"input">
  | MediaStreamEndedEvent<"input">
  | MediaAudioChunkEvent<"input">
  | SpeechStartedEvent
  | SpeechEndedEvent
  | SilenceStartedEvent
  | SilenceEndedEvent
  | BargeInDetectedEvent
  | DtmfReceivedEvent
  | MediaErrorEvent<"input">;

export type OutputMediaEvent =
  | MediaStreamStartedEvent<"output">
  | MediaStreamEndedEvent<"output">
  | MediaAudioChunkEvent<"output">
  | MediaAudioCommittedEvent
  | MediaErrorEvent<"output">;

export type InternalMediaEvent =
  | MediaStreamStartedEvent<"internal">
  | MediaStreamEndedEvent<"internal">
  | MediaErrorEvent<"internal">;

export type MediaEvent = InputMediaEvent | OutputMediaEvent | InternalMediaEvent;

export type InputAudioChunk = MediaAudioChunkEvent<"input">;
export type OutputAudioChunk = MediaAudioChunkEvent<"output">;
