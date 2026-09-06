import {
  internalError,
  TvicThrowableError,
  timeoutError,
  type CallHandle,
  type TtsStream,
} from "@tvic/core";

import { abortPromise, stallTimer } from "./async-control.js";
import * as pipelineConstants from "./pipeline-constants.js";
import { appendAlignedTokens } from "./turn-alignment.js";
import type { ActiveTurnControl, MutableTurnLatency } from "./turn-state.js";

export interface PipelineTtsPlaybackOptions {
  readonly callHandle: CallHandle;
  readonly stallTimeoutMs: number;
  readonly onTimeout: "fail" | "interrupt";
  readonly monotonicMs: () => number;
  readonly abortActive: (reason: string) => void;
  readonly emitAudio: (bytes: Uint8Array, sequence: number) => void;
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
  let audioDeadline = Date.now() + options.stallTimeoutMs;

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
      await stream.cancel();
      throw TvicThrowableError.from(
        timeoutError("tts.stalled", `TTS produced no audio for ${options.stallTimeoutMs}ms`),
      );
    }
    if (step.kind === "abort" || step.kind === "timeout") {
      if (step.kind === "timeout") options.abortActive("timeout");
      await stream.cancel();
      control.speaking = false;
      return;
    }
    if (step.result.done) break;

    const raw = step.result.value;
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
        await stream.cancel();
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
      raw.type === "media.audio.chunk" ? { ...raw, monotonicOffsetMs: options.monotonicMs() } : raw;
    if (control.abort.signal.aborted) {
      await stream.cancel();
      control.speaking = false;
      return;
    }
    const delivered = await options.callHandle.send(event);
    const isCommit = event.type === "media.audio.committed";
    if (!delivered && (event.type === "media.audio.chunk" || isCommit)) {
      options.abortActive("transport_closed");
      await stream.cancel();
      control.speaking = false;
      return;
    }
    if (isCommit) committedMarkId = String(event.id);
    if (event.type === "media.audio.chunk") {
      options.emitAudio(new Uint8Array(event.audio.bytes), event.sequence);
      audioDeadline = Date.now() + options.stallTimeoutMs;
      control.speaking = true;
      latency.firstAudioMs ??= options.monotonicMs() - control.startedAtMs;
      control.outputFramesSent += event.audio.frameCount;
    }
  }

  control.outputDelivered = await confirmPlayout(options.callHandle, committedMarkId, control);
  control.speaking = false;
}

async function confirmPlayout(
  callHandle: CallHandle,
  markId: string | null,
  control: ActiveTurnControl,
): Promise<boolean> {
  if (!callHandle.confirmPlayout) return true;
  if (!markId) return false;
  const delivered = await Promise.race([
    callHandle.confirmPlayout(markId, pipelineConstants.PLAYOUT_CONFIRM_TIMEOUT_MS),
    abortPromise(control.abort.signal).then(() => false),
  ]);
  return !control.abort.signal.aborted && delivered;
}
