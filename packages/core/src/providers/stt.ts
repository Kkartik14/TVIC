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
  readonly interimResults: boolean;
  readonly vocabulary?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface SttStream {
  readonly events: AsyncIterable<TranscriptEvent>;
  sendAudio(chunk: InputAudioChunk): Promise<void>;
  commit(): Promise<void>;
  close(): Promise<void>;
}

export interface SpeechToTextProvider extends Provider {
  readonly kind: "stt";
  open(request: SttOpenRequest): Promise<SttStream>;
}
