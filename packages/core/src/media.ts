import type { AudioFormat, AudioPayload } from "./audio.js";
import type { MediaDirection } from "./direction.js";
import type { NormalizedError } from "./errors.js";
import type { CallId, MediaEventId, SessionId, TurnId } from "./ids.js";
import type { Timestamp } from "./timestamp.js";

export type MediaEventType =
  | "media.stream.started"
  | "media.stream.ended"
  | "media.audio.chunk"
  | "media.audio.committed"
  | "media.turn.commit_requested"
  | "media.interrupt.requested"
  | "dtmf.received"
  | "media.error";

/**
 * Coarse-grained category of a media event. Use `kind` (a string field on
 * every `MediaEvent`) to filter or dispatch without depending on the
 * finer-grained `type` literal.
 *
 *   - `"media"`     — audio data frames, audio delivery confirmations
 *   - `"signal"`    — control signals (commit, interrupt, DTMF)
 *   - `"lifecycle"` — stream start/end, errors
 */
export type MediaEventKind = "media" | "signal" | "lifecycle";

/**
 * Compile-time map of every `MediaEventType` to its `MediaEventKind`. Using
 * a `Record<MediaEventType, MediaEventKind>` (not a `Map`) means adding a
 * new event type to the union forces a compile error here until the
 * entry is added. The map is the single source of truth for "what kind
 * is this event?"
 */
export const EVENT_KIND_MAP = {
  "media.stream.started": "lifecycle",
  "media.stream.ended": "lifecycle",
  "media.audio.chunk": "media",
  "media.audio.committed": "media",
  "media.turn.commit_requested": "signal",
  "media.interrupt.requested": "signal",
  "dtmf.received": "signal",
  "media.error": "lifecycle",
} as const satisfies Record<MediaEventType, MediaEventKind>;

export function kindForMediaEvent(type: MediaEventType): MediaEventKind {
  return EVENT_KIND_MAP[type];
}

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
  /**
   * Coarse-grained category derived from `type`. Every media event must carry
   * the category that corresponds to its event type; use `createMediaEvent`
   * when constructing an event so the value cannot drift from the map below.
   */
  readonly kind: MediaEventKind;
  readonly sessionId: SessionId;
  readonly callId?: CallId;
  readonly turnId?: TurnId;
  readonly sequence: number;
  readonly direction: D;
  readonly timestamp: Timestamp;
  /**
   * Source-clock position of the audio. Input events carry the transport's own
   * timeline (e.g. Twilio's media timestamp, the browser client's capture
   * clock). Output chunks are constructed with `0` by synthesis adapters and
   * restamped by `PipelineVoiceLoop` with its monotonic send clock before
   * delivery; delivery proof travels via commit marks, not this field.
   */
  readonly monotonicOffsetMs: number;
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

export interface DtmfReceivedEvent extends MediaEventBase<"dtmf.received", "input"> {
  readonly digit: DtmfDigit;
  readonly durationMs?: number;
}

export interface TurnCommitRequestedEvent extends MediaEventBase<
  "media.turn.commit_requested",
  "input"
> {}

export interface InterruptRequestedEvent extends MediaEventBase<
  "media.interrupt.requested",
  "input"
> {}

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
  | TurnCommitRequestedEvent
  | InterruptRequestedEvent
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

/**
 * Initialization shape for any media event. The union preserves each event's
 * type-specific fields while leaving out the derived `kind` field.
 */
type WithoutMediaEventKind<T> = T extends MediaEvent ? Omit<T, "kind"> : never;

export type AnyMediaEventInit = WithoutMediaEventKind<MediaEvent>;

/**
 * Adds the required coarse-grained category to a media event. The overload
 * keeps the correlated event type available to callers; the implementation
 * itself returns the complete `MediaEvent` union and contains no assertion.
 */
export function createMediaEvent<T extends AnyMediaEventInit>(
  init: T,
): Extract<MediaEvent, { readonly type: T["type"]; readonly direction: T["direction"] }>;
export function createMediaEvent(init: AnyMediaEventInit): MediaEvent {
  return {
    ...init,
    kind: EVENT_KIND_MAP[init.type],
  };
}

export type InputAudioChunk = MediaAudioChunkEvent<"input">;
export type OutputAudioChunk = MediaAudioChunkEvent<"output">;
