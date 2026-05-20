import type {
  CallId,
  InputMediaEvent,
  MediaDirection,
  MediaEvent,
  MediaEventType,
  OutputMediaEvent,
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

export class MediaEventBuffer {
  readonly #events: MediaEvent[] = [];

  append(event: MediaEvent): void {
    this.#events.push(event);
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

  clear(): void {
    this.#events.length = 0;
  }
}

export function createMediaEventBuffer(): MediaEventBuffer {
  return new MediaEventBuffer();
}

export type { InputMediaEvent, MediaEvent, MediaEventType, OutputMediaEvent };
