import type { AudioFormat } from "../audio.js";
import type { SessionId } from "../ids.js";
import type { InputAudioChunk } from "../media.js";
import type { Provider } from "../provider.js";
import type { TranscriptEvent } from "./transcript.js";

export interface SttOpenRequest {
  readonly sessionId: SessionId;
  readonly format: AudioFormat;
  readonly language?: string;
  readonly model?: string;
  readonly allowUnknownModel?: boolean;
  readonly interimResults: boolean;
  readonly vocabulary?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
}

export type SttCommitMode = "provider" | "none";
/**
 * Origin of audio offsets emitted by an STT stream. Reconnectable streams must
 * declare this so the runtime can keep one session-relative timeline across fresh
 * provider generations.
 */
export type SttTimestampOrigin = "session" | "generation";
export const STT_STREAM_ENDED_REASON = "stream_ended";

export interface SttStream {
  readonly events: AsyncIterable<TranscriptEvent>;
  readonly commitMode?: SttCommitMode;
  readonly timestampOrigin?: SttTimestampOrigin;
  sendAudio(chunk: InputAudioChunk): Promise<void>;
  commit(): Promise<void>;
  close(): Promise<void>;
}

export interface SpeechToTextProvider extends Provider {
  readonly kind: "stt";
  open(request: SttOpenRequest): Promise<SttStream>;
}
