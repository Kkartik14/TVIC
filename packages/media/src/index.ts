import type {
  CallId,
  InputMediaEvent,
  MediaDirection,
  MediaEvent,
  MediaEventType,
  OutputMediaEvent,
  PayloadRef,
  SessionId,
} from "@tvic/core";

export interface MediaEventQuery {
  readonly sessionId?: SessionId;
  readonly callId?: CallId;
  readonly direction?: MediaDirection;
  readonly types?: readonly MediaEventType[];
  readonly limit?: number;
}

export function isInputMediaEvent(event: MediaEvent): event is InputMediaEvent {
  return event.direction === "input";
}

export function isOutputMediaEvent(event: MediaEvent): event is OutputMediaEvent {
  return event.direction === "output";
}

/**
 * Strips raw inline PCM from a media event, keeping only trace-safe metadata
 * (format, duration, frame count). Inline bytes become a `ref` keyed by the event
 * id — the same ref the artifact writer uses — so nothing retains caller audio in
 * memory unless it was explicitly persisted under consent.
 */
export function toTraceSafeMediaEvent(event: MediaEvent): MediaEvent {
  if (event.type !== "media.audio.chunk" || event.audio.data.kind !== "inline") {
    return event;
  }
  return {
    ...event,
    audio: {
      ...event.audio,
      data: { kind: "ref", ref: String(event.id) as PayloadRef },
    },
  };
}

export class MediaEventBuffer {
  readonly #events: MediaEvent[] = [];
  readonly #maxEvents: number;

  // Bounded so a long-running runtime can never accumulate unbounded media metadata.
  constructor(options: { readonly maxEvents?: number } = {}) {
    this.#maxEvents = options.maxEvents ?? 100_000;
  }

  append(event: MediaEvent): void {
    this.#events.push(event);
    if (this.#events.length > this.#maxEvents) {
      this.#events.shift();
    }
  }

  query(query: MediaEventQuery = {}): readonly MediaEvent[] {
    const events = this.#events.filter((event) => {
      if (query.sessionId && event.sessionId !== query.sessionId) {
        return false;
      }

      if (query.callId && event.callId !== query.callId) {
        return false;
      }

      if (query.direction && event.direction !== query.direction) {
        return false;
      }

      if (query.types && !query.types.includes(event.type)) {
        return false;
      }

      return true;
    });

    return typeof query.limit === "number" ? events.slice(0, query.limit) : events;
  }

  all(): readonly MediaEvent[] {
    return [...this.#events];
  }

  /** Current number of buffered events (for leak/bounds assertions). */
  size(): number {
    return this.#events.length;
  }

  clear(): void {
    this.#events.length = 0;
  }

  /** Drops a finished session's events so per-call memory is released promptly. */
  clearSession(sessionId: SessionId): void {
    for (let i = this.#events.length - 1; i >= 0; i -= 1) {
      if (this.#events[i]?.sessionId === sessionId) {
        this.#events.splice(i, 1);
      }
    }
  }
}

export function createMediaEventBuffer(): MediaEventBuffer {
  return new MediaEventBuffer();
}

export {
  PCM16_BYTES_PER_SAMPLE,
  assertPcm16leFormat,
  base64ToBytes,
  bytesToBase64,
  durationMsForPcm16le,
  frameCountForPcm16le,
  mulawToPcm16le,
  pcm16leToMulaw,
  resamplePcm16le,
  splitPcm16leFrames,
} from "./audio-codec.js";

export type { InputMediaEvent, MediaEvent, MediaEventType, OutputMediaEvent };
