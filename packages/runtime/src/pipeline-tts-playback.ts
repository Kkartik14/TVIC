import {
  internalError,
  providerError,
  TvicThrowableError,
  timeoutError,
  type CallHandle,
  type NormalizedError,
  type TtsEvent,
  type TtsStream,
} from "@tvic/core";

import {
  abortPromise,
  cancelWithTimeout,
  returnAsyncIteratorWithTimeout,
  stallTimer,
  withTimeout,
} from "./async-control.js";
import * as pipelineConstants from "./pipeline-constants.js";
import { appendAlignedTokens } from "./turn-alignment.js";
import type { ActiveTurnControl, MutableTurnLatency } from "./turn-state.js";

export interface PipelineTtsPlaybackOptions {
  readonly sessionId: string;
  readonly turnId: string;
  readonly callHandle: CallHandle;
  readonly stallTimeoutMs: number;
  readonly onTimeout: "fail" | "interrupt";
  readonly monotonicMs: () => number;
  readonly abortActive: (reason: string) => void;
  readonly emitAudio: (bytes: Uint8Array, sequence: number) => void;
  /** Receives recoverable provider-shape warnings without affecting playback. */
  readonly onWarning?: (error: NormalizedError) => void;
  /** Reports a provider that ignored cancellation past the cancel budget. */
  readonly onCancelTimeout?: () => void;
  /** Reports a provider iterator that ignored return() past the cleanup budget. */
  readonly onIteratorTimeout?: () => void;
  /** Bounds transport acknowledgement for one outbound media event. */
  readonly sendTimeoutMs?: number;
}

/** Delivers one TTS stream, including playout confirmation and cancellation. */
export async function playPipelineTtsStream(
  stream: TtsStream,
  control: ActiveTurnControl,
  latency: MutableTurnLatency,
  options: PipelineTtsPlaybackOptions,
): Promise<void> {
  let iterator: AsyncIterator<TtsEvent>;
  try {
    iterator = stream.events[Symbol.asyncIterator]();
  } catch (error) {
    // A provider can fail while creating the iterator itself. The stream is
    // still owned by this function, so release it with the same bounded
    // cancellation policy used after iteration has started.
    await cancelWithTimeout(
      () => stream.cancel(),
      pipelineConstants.CANCELLATION_TIMEOUT_MS,
      () => options.onCancelTimeout?.(),
    ).catch(() => undefined);
    throw error;
  }
  const aborted = abortPromise(control.abort.signal);
  let committedMarkId: string | null = null;
  let audioDeadline = Date.now() + options.stallTimeoutMs;
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await stopTtsStream(stream, iterator, options);
  };

  try {
    while (true) {
      const stall = stallTimer(Math.max(0, audioDeadline - Date.now()));
      const next = iterator.next();
      next.catch(() => undefined);
      const step = await Promise.race([
        next.then((result) => ({ kind: "chunk" as const, result })),
        aborted.then(() => ({ kind: "abort" as const })),
        stall.promise.then(() => ({ kind: "timeout" as const })),
      ]);
      stall.cancel();

      if (step.kind === "timeout" && options.onTimeout === "fail") {
        await stop();
        throw TvicThrowableError.from(
          timeoutError("tts.stalled", `TTS produced no audio for ${options.stallTimeoutMs}ms`),
        );
      }
      if (step.kind === "abort" || step.kind === "timeout") {
        if (step.kind === "timeout") options.abortActive("timeout");
        await stop();
        control.speaking = false;
        return;
      }
      if (control.abort.signal.aborted) {
        await stop();
        control.speaking = false;
        return;
      }
      if (step.result.done) break;

      const raw = step.result.value;
      if (raw.sessionId !== options.sessionId || raw.turnId !== options.turnId) {
        await stop();
        throw TvicThrowableError.from(
          providerError("provider.identity_mismatch", "TTS event identity mismatch", {
            ...(raw.provider ? { provider: raw.provider } : {}),
            retriable: false,
          }),
        );
      }
      if (raw.type === "tts.alignment") {
        if (control.alignedUnit !== raw.unit) {
          control.alignedTokens.length = 0;
          control.alignedCharacterStarts.clear();
          control.alignedUnit = raw.unit;
        }
        appendAlignedTokens(
          control.alignedTokens,
          raw.tokens,
          raw.unit,
          raw.startMs,
          control.alignedCharacterStarts,
        );
        control.alignedDurationMs = Math.max(control.alignedDurationMs, ...raw.endMs, 0);
        continue;
      }
      if (raw.type === "tts.flush.completed") {
        if (control.lastFlushSequence !== null && raw.sequence <= control.lastFlushSequence) {
          await stop();
          throw TvicThrowableError.from(
            internalError(
              "tts.flush_out_of_order",
              `TTS flush sequence ${raw.sequence} followed ${control.lastFlushSequence}`,
            ),
          );
        }
        control.lastFlushSequence = raw.sequence;
        continue;
      }

      const event =
        raw.type === "media.audio.chunk"
          ? { ...raw, monotonicOffsetMs: options.monotonicMs() }
          : raw;
      if (control.abort.signal.aborted) {
        await stop();
        control.speaking = false;
        return;
      }
      if (event.type === "media.audio.chunk" && event.audio.bytes.byteLength === 0) {
        try {
          options.onWarning?.(
            internalError("tts.empty_chunk", "TTS emitted an empty audio chunk", {
              ...(event.provider ? { provider: event.provider } : {}),
            }),
          );
        } catch {
          // Warning observers must not affect live playback.
        }
        continue;
      }
      let delivered: boolean;
      try {
        delivered = await withTimeout(
          Promise.resolve().then(() => options.callHandle.send(event)),
          options.sendTimeoutMs ?? pipelineConstants.TRANSPORT_SEND_TIMEOUT_MS,
          timeoutError(
            "media.send_timeout",
            `Outbound media delivery timed out after ${options.sendTimeoutMs ?? pipelineConstants.TRANSPORT_SEND_TIMEOUT_MS}ms`,
            { retriable: false },
          ),
        );
      } catch (error) {
        options.abortActive("transport_send_timeout");
        await stop();
        control.speaking = false;
        throw TvicThrowableError.from(error);
      }
      const isCommit = event.type === "media.audio.committed";
      if (!delivered && (event.type === "media.audio.chunk" || isCommit)) {
        options.abortActive("transport_closed");
        await stop();
        control.speaking = false;
        return;
      }
      if (isCommit) committedMarkId = String(event.id);
      if (event.type === "media.audio.chunk") {
        try {
          options.emitAudio(new Uint8Array(event.audio.bytes), event.sequence);
        } catch (error) {
          options.abortActive("audio_emit_failed");
          await stop();
          control.speaking = false;
          throw error;
        }
        audioDeadline = Date.now() + options.stallTimeoutMs;
        control.speaking = true;
        latency.firstAudioMs ??= options.monotonicMs() - control.startedAtMs;
        control.outputFramesSent += event.audio.frameCount;
      }
    }

    control.outputDelivered = await confirmPlayout(options.callHandle, committedMarkId, control);
    control.speaking = false;
  } catch (error) {
    await stop();
    control.speaking = false;
    throw error;
  }
}

async function stopTtsStream<T>(
  stream: TtsStream,
  iterator: AsyncIterator<T>,
  options: PipelineTtsPlaybackOptions,
): Promise<void> {
  // Cleanup is best effort. A provider cleanup failure must not replace the
  // timeout, identity, ordering, or transport error that caused shutdown.
  await cancelWithTimeout(
    () => stream.cancel(),
    pipelineConstants.CANCELLATION_TIMEOUT_MS,
    () => options.onCancelTimeout?.(),
  ).catch(() => undefined);
  await returnAsyncIteratorWithTimeout(iterator, pipelineConstants.CANCELLATION_TIMEOUT_MS, () =>
    options.onIteratorTimeout?.(),
  );
}

async function confirmPlayout(
  callHandle: CallHandle,
  markId: string | null,
  control: ActiveTurnControl,
): Promise<boolean> {
  if (!callHandle.confirmPlayout) return true;
  if (!markId) return false;
  const delivered = await Promise.race([
    withTimeout(
      Promise.resolve().then(() =>
        callHandle.confirmPlayout!(markId, pipelineConstants.PLAYOUT_CONFIRM_TIMEOUT_MS),
      ),
      pipelineConstants.PLAYOUT_CONFIRM_TIMEOUT_MS,
      false,
    ).catch(() => false),
    abortPromise(control.abort.signal).then(() => false),
  ]);
  return !control.abort.signal.aborted && delivered;
}
