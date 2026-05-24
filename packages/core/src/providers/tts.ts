import type { AudioFormat } from "../audio.js";
import type { SessionId, TurnId } from "../ids.js";
import type { MediaAudioCommittedEvent, OutputAudioChunk } from "../media.js";
import type { Provider } from "../provider.js";

export interface TtsSynthesisRequest {
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly text: string;
  readonly voice?: string;
  readonly model?: string;
  readonly format: AudioFormat;
  readonly stream: boolean;
  readonly speed?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Aborts startup (e.g. a connect timeout) so a stalled synthesize does not leak. */
  readonly signal?: AbortSignal;
}

export type TtsEvent = OutputAudioChunk | MediaAudioCommittedEvent;

export interface TtsStream {
  readonly events: AsyncIterable<TtsEvent>;
  cancel(): Promise<void>;
}

export interface TextToSpeechProvider extends Provider {
  readonly kind: "tts";
  synthesize(request: TtsSynthesisRequest): Promise<TtsStream>;
}
