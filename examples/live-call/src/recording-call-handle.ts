import type {
  CallArtifactSink,
  CallHandle,
  InboundMediaEvent,
  OutputMediaEvent,
  PayloadRef,
  StreamEndReason,
} from "@tvic/core";

/**
 * Wraps a real CallHandle and persists the normalized PCM that flows through it
 * (caller audio in, agent audio out) to the per-call artifact sink. The sink owns
 * write ordering and drain-on-close, so this only needs to forward each chunk.
 * Payloads carry the source media-event id for trace ↔ audio alignment.
 */
export interface RecordingCallHandleOptions {
  /** The session clock — stamps persisted audio so input/output/traces share one origin. */
  readonly now: () => number;
  readonly onError?: (error: unknown) => void;
}

export function recordingCallHandle(
  inner: CallHandle,
  sink: CallArtifactSink,
  options: RecordingCallHandleOptions,
): CallHandle {
  const onError = options.onError ?? (() => undefined);

  // Stamp an inbound audio chunk to the session clock exactly once. The provider
  // offset is preserved in metadata, which is also the runtime's signal to reuse this
  // stamp (instead of re-stamping at injection) — so the traced event and the
  // persisted audio share one timestamp.
  const stampInput = (event: InboundMediaEvent): InboundMediaEvent => {
    if (
      event.type !== "media.audio.chunk" ||
      event.metadata?.providerMonotonicOffsetMs !== undefined
    ) {
      return event;
    }
    return {
      ...event,
      monotonicOffsetMs: options.now(),
      metadata: { ...event.metadata, providerMonotonicOffsetMs: event.monotonicOffsetMs },
    };
  };

  const persistInput = (event: InboundMediaEvent): void => {
    if (event.type !== "media.audio.chunk" || event.audio.data.kind !== "inline") {
      return;
    }
    void sink
      .appendAudio({
        payloadRef: String(event.id) as PayloadRef,
        mediaEventId: event.id,
        direction: "input",
        bytes: event.audio.data.bytes,
        monotonicOffsetMs: event.monotonicOffsetMs, // the single stamp from stampInput
        durationMs: event.audio.durationMs,
        format: event.audio.format,
      })
      .catch(onError);
  };

  const persistOutput = (event: OutputMediaEvent): void => {
    if (event.type !== "media.audio.chunk" || event.audio.data.kind !== "inline") {
      return;
    }
    void sink
      .appendAudio({
        payloadRef: String(event.id) as PayloadRef,
        mediaEventId: event.id,
        direction: "output",
        bytes: event.audio.data.bytes,
        monotonicOffsetMs: event.monotonicOffsetMs, // reuse the loop's single send-time stamp
        durationMs: event.audio.durationMs,
        format: event.audio.format,
      })
      .catch(onError);
  };

  async function* tappedEvents(): AsyncIterable<InboundMediaEvent> {
    for await (const event of inner.events) {
      const stamped = stampInput(event);
      persistInput(stamped);
      yield stamped;
    }
  }

  return {
    callId: inner.callId,
    events: tappedEvents(),
    async send(event: OutputMediaEvent): Promise<boolean> {
      const delivered = await inner.send(event);
      // Only persist audio the caller actually heard.
      if (delivered) {
        persistOutput(event);
      }
      return delivered;
    },
    clear(): Promise<void> {
      return inner.clear();
    },
    cancelOutput(reason?: string): Promise<void> {
      return inner.cancelOutput(reason);
    },
    close(reason: StreamEndReason): Promise<void> {
      return inner.close(reason);
    },
    ...(inner.confirmPlayout
      ? {
          confirmPlayout: (markId: string, timeoutMs: number): Promise<boolean> =>
            inner.confirmPlayout!(markId, timeoutMs),
        }
      : {}),
  };
}
