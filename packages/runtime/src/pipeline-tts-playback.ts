import {
  internalError,
  providerError,
  TvicThrowableError,
  timeoutError,
  type CallHandle,
  type NormalizedError,
  type TurnId,
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
import { AUDIO_TAP_MAX_BUFFERED_BYTES } from "./audio-tap.js";
import * as pipelineConstants from "./pipeline-constants.js";
import { runtimeResourceLimitError } from "./pipeline-resource-limits.js";
import { appendAlignedTokens } from "./turn-alignment.js";
import type { ActiveTurnControl, MutableTurnLatency } from "./turn-state.js";

export interface PendingAudioTapSendTracking {
  readonly release: () => void;
  readonly releaseCloseCallback: () => void;
}

export interface PipelineTtsPlaybackOptions {
  readonly sessionId: string;
  readonly turnId: TurnId;
  readonly callHandle: CallHandle;
  readonly stallTimeoutMs: number;
  readonly onTimeout: "fail" | "interrupt";
  readonly monotonicMs: () => number;
  readonly abortActive: (reason: string) => void;
  readonly emitAudio: (bytes: Uint8Array, sequence: number) => void;
  readonly onAudioSent?: (
    event: Extract<TtsEvent, { readonly type: "media.audio.chunk" }>,
    bytesCaptured: boolean,
  ) => void;
  readonly onAudioReceived?: (
    event: Extract<TtsEvent, { readonly type: "media.audio.chunk" }>,
  ) => void;
  readonly onInterrupted?: () => void;
  readonly onAudioTapDropped?: () => void;
  readonly onPlayout?: (input: { readonly markId: string; readonly confirmed: boolean }) => void;
  readonly trackAudioTapOperation?: () => () => void;
  readonly trackPendingAudioTapSend?: (
    turnId: TurnId,
    onTapClose: () => void,
  ) => PendingAudioTapSendTracking;
  readonly onWarning?: (error: NormalizedError) => void;
  readonly onCancelTimeout?: () => void;
  readonly onIteratorTimeout?: () => void;
  readonly sendTimeoutMs?: number;
}

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
    await cancelWithTimeout(
      () => stream.cancel(),
      pipelineConstants.CANCELLATION_TIMEOUT_MS,
      () => options.onCancelTimeout?.(),
    ).catch(() => undefined);
    throw error;
  }

  const aborted = abortPromise(control.abort.signal);
  const sessionId = options.sessionId;
  const turnId = options.turnId;
  const pendingAudioReceiver: PendingAudioReceiver = { callback: options.onAudioReceived };
  let committedMarkId: string | null = null;
  let audioDelivered = false;
  let audioAttempted = false;
  let playbackCompleted = false;
  let audioDeadline = options.monotonicMs() + options.stallTimeoutMs;
  control.outputDelivered = false;
  let stopped = false;
  let usageInterrupted = false;
  const interruptUsage = (): void => {
    if (usageInterrupted) return;
    usageInterrupted = true;
    try {
      options.onInterrupted?.();
    } catch {}
  };
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    try {
      await stopTtsStream(stream, iterator, options);
    } finally {
      pendingAudioReceiver.callback = undefined;
    }
  };

  try {
    while (true) {
      const stall = stallTimer(Math.max(0, audioDeadline - options.monotonicMs()));
      const next = iterator.next();
      next.catch(() => undefined);
      const step = await Promise.race([
        next.then((result) => {
          recordYieldedAudio(result, sessionId, turnId, pendingAudioReceiver);
          return { kind: "chunk" as const, result };
        }),
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
        interruptUsage();
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
      if (control.abort.signal.aborted) {
        await stop();
        interruptUsage();
        control.speaking = false;
        return;
      }
      if (raw.type === "tts.alignment") {
        if (control.alignedUnit !== raw.unit) {
          control.alignedTokens.length = 0;
          control.alignedTokenBytes = 0;
          control.alignedCharacterStarts.clear();
          control.alignedUnit = raw.unit;
          control.alignedDurationMs = 0;
        }
        if (raw.endMs.length > pipelineConstants.MAX_RUNTIME_TTS_ALIGNMENT_ARRAY_ENTRIES) {
          await stop();
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
          await stop();
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
      if (event.type === "media.audio.chunk" && event.audio.bytes.byteLength === 0) {
        try {
          options.onWarning?.(
            internalError("tts.empty_chunk", "TTS emitted an empty audio chunk", {
              ...(event.provider ? { provider: event.provider } : {}),
            }),
          );
        } catch {}
        continue;
      }
      if (control.abort.signal.aborted) {
        await stop();
        interruptUsage();
        control.speaking = false;
        return;
      }
      let delivered: boolean;
      if (event.type === "media.audio.chunk" || event.type === "media.audio.committed") {
        audioAttempted = true;
        control.audioDelivery = "not_accepted";
      }
      const releaseAudioTapOperation = options.trackAudioTapOperation?.();
      let audioTapSnapshot =
        event.type === "media.audio.chunk" && options.onAudioSent
          ? captureAudioTapEvent(event)
          : undefined;
      let onAudioSent = options.onAudioSent;
      let sendTimedOut = false;
      const releaseAudioTapObservation = () => {
        audioTapSnapshot = undefined;
        onAudioSent = undefined;
      };
      let pendingAudioTapSend: PendingAudioTapSendTracking | undefined;
      const releaseTapTracking = () => {
        pendingAudioTapSend?.release();
        pendingAudioTapSend = undefined;
        releaseAudioTapObservation();
      };
      pendingAudioTapSend = options.trackPendingAudioTapSend?.(
        options.turnId,
        releaseAudioTapObservation,
      );
      const transportSend = Promise.resolve().then(() => options.callHandle.send(event));
      if (pendingAudioTapSend || audioTapSnapshot) {
        void transportSend.then((accepted) => {
          if (accepted && !sendTimedOut && audioTapSnapshot && onAudioSent) {
            try {
              onAudioSent(audioTapSnapshot.event, audioTapSnapshot.bytesCaptured);
            } catch {}
          }
          releaseTapTracking();
        }, releaseTapTracking);
      }
      try {
        try {
          const timeoutMs = options.sendTimeoutMs ?? pipelineConstants.TRANSPORT_SEND_TIMEOUT_MS;
          let sendTimer: ReturnType<typeof setTimeout> | undefined;
          const sendDeadline = new Promise<never>((_resolve, reject) => {
            sendTimer = setTimeout(() => {
              sendTimedOut = true;
              reject(
                timeoutError(
                  "media.send_timeout",
                  `Outbound media delivery timed out after ${timeoutMs}ms`,
                  {
                    retriable: false,
                  },
                ),
              );
            }, timeoutMs);
          });
          try {
            const sendResult = await Promise.race([
              transportSend.then((accepted) => ({ kind: "sent" as const, accepted })),
              sendDeadline,
              aborted.then(() => ({ kind: "aborted" as const })),
            ]);
            if (sendResult.kind === "aborted") {
              await stop();
              interruptUsage();
              control.speaking = false;
              return;
            }
            delivered = sendResult.accepted;
          } finally {
            if (sendTimer !== undefined) clearTimeout(sendTimer);
          }
        } catch (error) {
          if (sendTimedOut) {
            if (audioTapSnapshot) {
              try {
                options.onAudioTapDropped?.();
              } catch {}
            }
            releaseAudioTapObservation();
            pendingAudioTapSend?.releaseCloseCallback();
          }
          options.abortActive("transport_send_timeout");
          releaseAudioTapOperation?.();
          await stop();
          interruptUsage();
          control.speaking = false;
          throw TvicThrowableError.from(error);
        }
        const isCommit = event.type === "media.audio.committed";
        if (!delivered && (event.type === "media.audio.chunk" || isCommit)) {
          options.abortActive("transport_closed");
          releaseAudioTapOperation?.();
          await stop();
          interruptUsage();
          control.speaking = false;
          return;
        }
        if (isCommit) committedMarkId = String(event.id);
        if (event.type === "media.audio.chunk") {
          try {
            options.emitAudio(
              audioTapSnapshot?.deliveryBytes
                ? audioTapSnapshot.deliveryBytes
                : new Uint8Array(event.audio.bytes),
              audioTapSnapshot?.event.sequence ?? event.sequence,
            );
          } catch (error) {
            options.abortActive("audio_emit_failed");
            await stop();
            interruptUsage();
            control.speaking = false;
            throw error;
          }
          audioDelivered = true;
          control.audioDelivery = "partially_accepted";
          audioDeadline = options.monotonicMs() + options.stallTimeoutMs;
          control.speaking = true;
          latency.firstAudioMs ??= options.monotonicMs() - control.startedAtMs;
          control.outputFramesSent += event.audio.frameCount;
        }
      } finally {
        releaseAudioTapOperation?.();
      }
    }

    let playoutConfirmed = false;
    if (audioDelivered) {
      const releaseAudioTapOperation = options.trackAudioTapOperation?.();
      try {
        playoutConfirmed = await confirmPlayout(options.callHandle, committedMarkId, control);
        if (committedMarkId && options.callHandle.confirmPlayout) {
          try {
            options.onPlayout?.({ markId: committedMarkId, confirmed: playoutConfirmed });
          } catch {}
        }
      } finally {
        releaseAudioTapOperation?.();
      }
    }
    // When the transport supports playout confirmation, only confirmed audio
    // advances the delivered-output state and the STT conversation context.
    control.outputDelivered = playoutConfirmed;
    if (audioDelivered) {
      control.audioDelivery = options.callHandle.confirmPlayout
        ? playoutConfirmed
          ? "playout_confirmed"
          : "playout_unconfirmed"
        : "transport_accepted";
    }
    playbackCompleted = true;
    control.speaking = false;
  } catch (error) {
    await stop();
    interruptUsage();
    control.speaking = false;
    throw error;
  } finally {
    if (!playbackCompleted && audioAttempted) {
      control.audioDelivery = control.outputFramesSent > 0 ? "partially_accepted" : "not_accepted";
    }
  }
}

interface PendingAudioReceiver {
  callback: PipelineTtsPlaybackOptions["onAudioReceived"] | undefined;
}

function recordYieldedAudio(
  result: IteratorResult<TtsEvent>,
  sessionId: string,
  turnId: TurnId,
  receiver: PendingAudioReceiver,
): void {
  if (result.done) return;
  const event = result.value;
  if (
    event.sessionId !== sessionId ||
    event.turnId !== turnId ||
    event.type !== "media.audio.chunk" ||
    event.audio.bytes.byteLength === 0
  ) {
    return;
  }
  try {
    receiver.callback?.(event);
  } catch {}
}

async function stopTtsStream<T>(
  stream: TtsStream,
  iterator: AsyncIterator<T>,
  options: PipelineTtsPlaybackOptions,
): Promise<void> {
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
      control.abort.signal,
      false,
    ).catch(() => false),
    abortPromise(control.abort.signal).then(() => false),
  ]);
  return !control.abort.signal.aborted && delivered;
}

function captureAudioTapEvent(event: Extract<TtsEvent, { readonly type: "media.audio.chunk" }>): {
  readonly event: Extract<TtsEvent, { readonly type: "media.audio.chunk" }>;
  readonly bytesCaptured: boolean;
  readonly deliveryBytes?: Uint8Array;
} {
  const bytes = event.audio.bytes;
  if (bytes.byteLength > AUDIO_TAP_MAX_BUFFERED_BYTES) {
    return {
      event: {
        ...event,
        audio: { ...event.audio, format: { ...event.audio.format }, bytes: new Uint8Array(0) },
      },
      bytesCaptured: false,
    };
  }
  let deliveryBytes: Uint8Array | undefined;
  try {
    deliveryBytes = new Uint8Array(bytes);
  } catch {}
  const bytesCaptured = deliveryBytes !== undefined;
  return {
    ...(deliveryBytes ? { deliveryBytes } : {}),
    event: {
      ...event,
      audio: {
        ...event.audio,
        format: { ...event.audio.format },
        bytes: bytesCaptured ? deliveryBytes! : new Uint8Array(0),
      },
    },
    bytesCaptured,
  };
}
