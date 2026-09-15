import {
  internalError,
  TvicThrowableError,
  timeoutError,
  type CallHandle,
  type NormalizedError,
  type TtsStream,
} from "@tvic/core";

import { abortPromise, stallTimer, withTimeout } from "./async-control.js";
import * as pipelineConstants from "./pipeline-constants.js";
import { appendAlignedTokens } from "./turn-alignment.js";
import { cancelProviderBounded, closeAsyncIterator } from "./pipeline-helpers.js";
import { runtimeResourceLimitError } from "./pipeline-resource-limits.js";
import type { ActiveTurnControl, MutableTurnLatency } from "./turn-state.js";

export interface PipelineTtsPlaybackOptions {
  readonly callHandle: CallHandle;
  readonly stallTimeoutMs: number;
  readonly onTimeout: "fail" | "interrupt";
  readonly monotonicMs: () => number;
  readonly abortActive: (reason: string) => void;
  readonly emitAudio: (bytes: Uint8Array, sequence: number) => void;
  /** Receives recoverable provider-shape warnings without affecting playback. */
  readonly onWarning?: (error: NormalizedError) => void;
}

/** Delivers one TTS stream, including playout confirmation and cancellation. */
export async function playPipelineTtsStream(
  stream: TtsStream,
  control: ActiveTurnControl,
  latency: MutableTurnLatency,
  options: PipelineTtsPlaybackOptions,
): Promise<void> {
  const iterator = stream.events[Symbol.asyncIterator]();
  const aborted = abortPromise(control.abort.signal);
  let committedMarkId: string | null = null;
  let audioDelivered = false;
  let audioDeadline = options.monotonicMs() + options.stallTimeoutMs;
  control.outputDelivered = false;

  try {
    while (true) {
      const stall = stallTimer(Math.max(0, audioDeadline - options.monotonicMs()));
      const next = iterator.next();
      next.catch(() => undefined);
      const step = await Promise.race([
        next.then((result) => ({ kind: "chunk" as const, result })),
        aborted.then(() => ({ kind: "abort" as const })),
        stall.promise.then(() => ({ kind: "timeout" as const })),
      ]);
      stall.cancel();

      if (step.kind === "timeout" && options.onTimeout === "fail") {
        await cancelTtsStream(stream);
        throw TvicThrowableError.from(
          timeoutError("tts.stalled", `TTS produced no audio for ${options.stallTimeoutMs}ms`),
        );
      }
      if (step.kind === "abort" || step.kind === "timeout") {
        if (step.kind === "timeout") options.abortActive("timeout");
        await cancelTtsStream(stream);
        control.speaking = false;
        return;
      }
      if (step.result.done) break;

      const raw = step.result.value;
      if (raw.type === "tts.alignment") {
        if (control.alignedUnit !== raw.unit) {
          control.alignedTokens.length = 0;
          control.alignedTokenBytes = 0;
          control.alignedCharacterStarts.clear();
          control.alignedUnit = raw.unit;
          control.alignedDurationMs = 0;
        }
        if (raw.endMs.length > pipelineConstants.MAX_RUNTIME_TTS_ALIGNMENT_ARRAY_ENTRIES) {
          await cancelTtsStream(stream);
          throw runtimeResourceLimitError(
            "TTS alignment event",
            "events",
            pipelineConstants.MAX_RUNTIME_TTS_ALIGNMENT_ARRAY_ENTRIES,
          );
        }
        try {
          control.alignedTokenBytes = appendAlignedTokens(
            control.alignedTokens,
            raw.tokens,
            raw.unit,
            raw.startMs,
            control.alignedCharacterStarts,
            control.alignedTokenBytes,
          );
        } catch (error) {
          await cancelTtsStream(stream);
          throw error;
        }
        for (const endMs of raw.endMs) {
          if (Number.isFinite(endMs)) {
            control.alignedDurationMs = Math.max(control.alignedDurationMs, endMs, 0);
          }
        }
        continue;
      }
      if (raw.type === "tts.flush.completed") {
        if (control.lastFlushSequence !== null && raw.sequence <= control.lastFlushSequence) {
          await cancelTtsStream(stream);
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
        await cancelTtsStream(stream);
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
          options.callHandle.send(event),
          pipelineConstants.TRANSPORT_SEND_TIMEOUT_MS,
          timeoutError(
            "tts.transport_send_timeout",
            `TTS transport send timed out after ${pipelineConstants.TRANSPORT_SEND_TIMEOUT_MS}ms`,
            { retriable: false },
          ),
        );
      } catch (error) {
        options.abortActive("transport_closed");
        await cancelTtsStream(stream);
        throw error;
      }
      const isCommit = event.type === "media.audio.committed";
      if (!delivered && (event.type === "media.audio.chunk" || isCommit)) {
        options.abortActive("transport_closed");
        await cancelTtsStream(stream);
        control.speaking = false;
        return;
      }
      if (isCommit) committedMarkId = String(event.id);
      if (event.type === "media.audio.chunk") {
        options.emitAudio(new Uint8Array(event.audio.bytes), event.sequence);
        audioDelivered = true;
        audioDeadline = options.monotonicMs() + options.stallTimeoutMs;
        control.speaking = true;
        latency.firstAudioMs ??= options.monotonicMs() - control.startedAtMs;
        control.outputFramesSent += event.audio.frameCount;
      }
    }

    control.outputDelivered =
      audioDelivered && (await confirmPlayout(options.callHandle, committedMarkId, control));
    control.speaking = false;
  } finally {
    await closeAsyncIterator(iterator, "TTS event iterator cleanup timed out");
  }
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
      callHandle.confirmPlayout(markId, pipelineConstants.PLAYOUT_CONFIRM_TIMEOUT_MS),
      pipelineConstants.PLAYOUT_CONFIRM_TIMEOUT_MS,
      timeoutError(
        "tts.playout_confirmation_timeout",
        `TTS playout confirmation timed out after ${pipelineConstants.PLAYOUT_CONFIRM_TIMEOUT_MS}ms`,
        { retriable: false },
      ),
    ).catch(() => false),
    abortPromise(control.abort.signal).then(() => false),
  ]);
  return !control.abort.signal.aborted && delivered;
}

async function cancelTtsStream(stream: TtsStream): Promise<void> {
  await cancelProviderBounded(
    () => stream.cancel(),
    `TTS cancellation timed out after ${pipelineConstants.PROVIDER_CANCEL_TIMEOUT_MS}ms`,
  ).catch(() => undefined);
}
