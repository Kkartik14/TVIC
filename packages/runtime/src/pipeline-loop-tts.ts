import {
  cancelledError,
  isIncrementalTextToSpeechProvider,
  type AudioFormat,
  type CallHandle,
  type NormalizedError,
  type SessionId,
  type TextToSpeechProvider,
  type TtsStream,
  type Turn,
  timeoutError,
} from "@tvic/core";

import { IncrementalTtsInput } from "./incremental-tts-input.js";
import { raceStartup } from "./pipeline-helpers.js";
import { STARTUP_TIMEOUT_MS } from "./pipeline-constants.js";
import { playPipelineTtsStream } from "./pipeline-tts-playback.js";
import type { ActiveTurnControl, MutableTurnLatency } from "./turn-state.js";
import type { VoiceEvent } from "./voice-event.js";

export interface PipelineTtsInputOptions {
  readonly provider: TextToSpeechProvider | undefined;
  readonly sessionId: SessionId;
  readonly turn: Turn;
  readonly format: AudioFormat;
  readonly voice?: string;
  readonly model?: string;
  readonly signal: AbortSignal;
}

export function createPipelineIncrementalTtsInput(
  options: PipelineTtsInputOptions,
): IncrementalTtsInput | null {
  const provider = options.provider;
  if (!provider || !isIncrementalTextToSpeechProvider(provider)) return null;

  return new IncrementalTtsInput({
    openSession: async () => {
      const opening = provider.openSession({
        sessionId: options.sessionId,
        turnId: options.turn.id,
        ...(options.voice ? { voice: options.voice } : {}),
        ...(options.model ? { model: options.model } : {}),
        format: options.format,
        timestamps: true,
        signal: options.signal,
      });
      const session = await raceStartup(opening, options.signal, (handle) => handle.cancel(), {
        timeoutMs: STARTUP_TIMEOUT_MS,
        timeoutReason: timeoutError(
          "tts.open_timeout",
          `TTS startup timed out after ${STARTUP_TIMEOUT_MS}ms`,
        ),
      });
      if (!session) throw cancelledError("tts.open_cancelled", "TTS session startup was cancelled");
      return session;
    },
  });
}

export async function speakPipelineTts(
  provider: TextToSpeechProvider,
  options: {
    readonly sessionId: SessionId;
    readonly turn: Turn;
    readonly text: string;
    readonly format: AudioFormat;
    readonly voice?: string;
    readonly model?: string;
    readonly signal: AbortSignal;
    readonly control: ActiveTurnControl;
    readonly latency: MutableTurnLatency;
    readonly play: (
      stream: TtsStream,
      control: ActiveTurnControl,
      latency: MutableTurnLatency,
    ) => Promise<void>;
  },
): Promise<void> {
  if (!options.text) {
    // An empty model response produced no participant-visible output. Leave the
    // control false so the turn boundary can classify it as unheard rather than
    // persisting a successful turn with no audio or text.
    options.control.outputDelivered = false;
    return;
  }

  const stream = await raceStartup(
    provider.synthesize({
      sessionId: options.sessionId,
      turnId: options.turn.id,
      text: options.text,
      ...(options.voice ? { voice: options.voice } : {}),
      ...(options.model ? { model: options.model } : {}),
      format: options.format,
      stream: true,
      signal: options.signal,
    }),
    options.signal,
    (handle) => handle.cancel(),
    {
      timeoutMs: STARTUP_TIMEOUT_MS,
      timeoutReason: timeoutError(
        "tts.open_timeout",
        `TTS startup timed out after ${STARTUP_TIMEOUT_MS}ms`,
      ),
    },
  );
  if (stream) await options.play(stream, options.control, options.latency);
}

export function playPipelineTts(
  stream: TtsStream,
  control: ActiveTurnControl,
  latency: MutableTurnLatency,
  options: {
    readonly callHandle: Parameters<typeof playPipelineTtsStream>[3]["callHandle"];
    readonly stallTimeoutMs: number;
    readonly onTimeout: "fail" | "interrupt";
    readonly monotonicMs: () => number;
    readonly abortActive: (reason: string) => void;
    readonly emitAudio: (bytes: Uint8Array, sequence: number) => void;
    readonly onWarning: (error: import("@tvic/core").NormalizedError) => void;
  },
): Promise<void> {
  return playPipelineTtsStream(stream, control, latency, options);
}

export function createPipelineTtsPlayer(options: {
  readonly callHandle: CallHandle;
  readonly stallTimeoutMs: number;
  readonly onTimeout: "fail" | "interrupt";
  readonly monotonicMs: () => number;
  readonly abortActive: (reason: string) => void;
  readonly emitVoiceEvent: (event: VoiceEvent) => void;
}): (stream: TtsStream, control: ActiveTurnControl, latency: MutableTurnLatency) => Promise<void> {
  return (stream, control, latency) =>
    playPipelineTts(stream, control, latency, {
      callHandle: options.callHandle,
      stallTimeoutMs: options.stallTimeoutMs,
      onTimeout: options.onTimeout,
      monotonicMs: options.monotonicMs,
      abortActive: options.abortActive,
      emitAudio: (bytes, sequence) =>
        options.emitVoiceEvent({ kind: "audio_output", bytes, turnId: control.turnId, sequence }),
      onWarning: (error: NormalizedError) =>
        options.emitVoiceEvent({ kind: "error", error, recoverable: true }),
    });
}
