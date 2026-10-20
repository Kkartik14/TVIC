import type { AudioFormat, AudioTapSummary, SessionId, TurnId } from "@tvic/core";

export const AUDIO_TAP_MAX_BUFFERED_AUDIO_FRAMES = 128;
export const AUDIO_TAP_MAX_BUFFERED_CONTROL_EVENTS = 64;
export const AUDIO_TAP_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
export const AUDIO_TAP_MAX_PENDING_SEND_TURNS = 64;
export const AUDIO_TAP_MAX_MARK_ID_LENGTH = 256;
const AUDIO_TAP_MAX_TRACKED_TURNS = 128;

export type AudioTapDirection = "caller" | "agent";

interface AudioTapFrameBase {
  readonly sessionId: SessionId;
  /** Session-relative monotonic time when TVIC observes the frame at its tap point. */
  readonly timestampMs: number;
  /** Increasing tap event sequence. Gaps indicate dropped frames or control events. */
  readonly sequence: number;
}

export interface AudioTapAudioFrame extends AudioTapFrameBase {
  readonly type: "audio";
  readonly direction: AudioTapDirection;
  readonly turnId?: TurnId;
  readonly format: AudioFormat;
  readonly bytes: Uint8Array;
}

export interface AudioTapClearedFrame extends AudioTapFrameBase {
  readonly type: "cleared";
  readonly direction: "agent";
  /** Turn that requested the transport-global clear, when there is one. */
  readonly turnId?: TurnId;
  /** Last session-wide agent audio sequence accepted before this clear was requested. */
  readonly throughSequence?: number;
  /** Whether one or more transport sends were still unsettled when the clear was requested. */
  readonly hadPendingSends: boolean;
  /** Turns with transport sends still unsettled when this clear was requested. */
  readonly pendingSendTurnIds?: readonly TurnId[];
  /** True when more than the bounded number of pending turns could not be listed. */
  readonly pendingSendTurnIdsTruncated?: boolean;
}

export interface AudioTapPlayoutFrame extends AudioTapFrameBase {
  readonly type: "playout";
  readonly direction: "agent";
  readonly turnId: TurnId;
  readonly markId: string;
  readonly confirmed: boolean;
  /** Last agent audio sequence sent for this turn when the playout result was observed. */
  readonly throughSequence?: number;
}

export type AudioTapFrame = AudioTapAudioFrame | AudioTapClearedFrame | AudioTapPlayoutFrame;

export interface AudioTapDrainContext {
  readonly sessionId: SessionId;
  readonly summary: AudioTapSummary;
}

export interface AudioTapOptions {
  readonly onFrame: (frame: AudioTapFrame) => void | PromiseLike<void>;
  /** Runs after close and after every queued onFrame callback has settled. */
  readonly onDrained?: (context: AudioTapDrainContext) => void | PromiseLike<void>;
}

export interface AudioTapDispatcherOptions {
  readonly sessionId: SessionId;
  readonly tap?: AudioTapOptions;
}

interface AudioTapAudioInput {
  readonly direction: AudioTapDirection;
  readonly turnId?: TurnId;
  readonly format: AudioFormat;
  readonly bytes: Uint8Array | null;
  readonly timestampMs: number;
}

interface QueuedFrame {
  readonly frame: AudioTapFrame;
  readonly isAudio: boolean;
  readonly audioBytes: number;
}

/**
 * Copies media into a bounded, serial queue. `onFrame` is always invoked from a
 * queued microtask, never from the media producer's stack, and its returned
 * promise is never awaited by the media loop.
 */
export class AudioTapDispatcher {
  readonly #sessionId: SessionId;
  readonly #tap: AudioTapOptions | undefined;
  readonly #queue: QueuedFrame[] = [];
  readonly #lastAgentAudioByTurn = new Map<TurnId, number>();
  #lastAgentAudioSequence: number | undefined;
  #nextSequence = 0;
  #queuedAudioFrames = 0;
  #queuedAudioBytes = 0;
  #queuedControlEvents = 0;
  #droppedFrames = 0;
  #droppedEvents = 0;
  #callbackErrors = 0;
  #scheduled = false;
  #drainedScheduled = false;
  #drainedNotified = false;
  #draining = false;
  #closed = false;

  constructor(options: AudioTapDispatcherOptions) {
    this.#sessionId = options.sessionId;
    this.#tap = options.tap;
  }

  audio(input: AudioTapAudioInput): number | undefined {
    if (!this.#tap || this.#closed) return undefined;
    const sequence = this.#nextSequence++;
    if (input.direction === "agent") {
      this.#lastAgentAudioSequence = sequence;
      if (input.turnId) {
        this.#lastAgentAudioByTurn.delete(input.turnId);
        this.#lastAgentAudioByTurn.set(input.turnId, sequence);
        if (this.#lastAgentAudioByTurn.size > AUDIO_TAP_MAX_TRACKED_TURNS) {
          const oldestTurnId = this.#lastAgentAudioByTurn.keys().next().value;
          if (oldestTurnId !== undefined) {
            this.#lastAgentAudioByTurn.delete(oldestTurnId);
          }
        }
      }
    }
    if (!input.bytes) {
      this.#droppedFrames += 1;
      return sequence;
    }
    if (
      this.#queuedAudioFrames >= AUDIO_TAP_MAX_BUFFERED_AUDIO_FRAMES ||
      input.bytes.byteLength > AUDIO_TAP_MAX_BUFFERED_BYTES - this.#queuedAudioBytes
    ) {
      this.#droppedFrames += 1;
      return sequence;
    }

    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(input.bytes);
    } catch {
      this.#droppedFrames += 1;
      return sequence;
    }
    this.#enqueue(
      {
        type: "audio",
        sessionId: this.#sessionId,
        direction: input.direction,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        sequence,
        timestampMs: input.timestampMs,
        format: { ...input.format },
        bytes,
      },
      true,
      bytes.byteLength,
    );
    return sequence;
  }

  agentAudioThroughSequence(turnId?: TurnId): number | undefined {
    if (turnId) return this.#lastAgentAudioByTurn.get(turnId);
    return this.#lastAgentAudioSequence;
  }

  cleared(input: {
    readonly turnId?: TurnId;
    readonly throughSequence?: number | undefined;
    readonly hadPendingSends?: boolean;
    readonly pendingSendTurnIds?: readonly TurnId[];
    readonly pendingSendTurnIdsTruncated?: boolean;
    readonly timestampMs: number;
  }): void {
    if (!this.#tap || this.#closed) return;
    const hasSequenceBoundary = Object.prototype.hasOwnProperty.call(input, "throughSequence");
    const throughSequence = hasSequenceBoundary
      ? input.throughSequence
      : this.agentAudioThroughSequence(input.turnId);
    if (hasSequenceBoundary) {
      if (throughSequence !== undefined) {
        for (const [turnId, sequence] of this.#lastAgentAudioByTurn) {
          if (sequence <= throughSequence) this.#lastAgentAudioByTurn.delete(turnId);
        }
      }
    } else if (input.turnId) {
      const latest = this.#lastAgentAudioByTurn.get(input.turnId);
      if (latest !== undefined) this.#lastAgentAudioByTurn.delete(input.turnId);
    } else {
      this.#lastAgentAudioByTurn.clear();
    }
    this.#control({
      type: "cleared",
      direction: "agent",
      sessionId: this.#sessionId,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(throughSequence !== undefined ? { throughSequence } : {}),
      hadPendingSends: input.hadPendingSends ?? false,
      ...(input.pendingSendTurnIds && input.pendingSendTurnIds.length > 0
        ? { pendingSendTurnIds: [...input.pendingSendTurnIds] }
        : {}),
      ...(input.pendingSendTurnIdsTruncated ? { pendingSendTurnIdsTruncated: true } : {}),
      sequence: this.#nextSequence++,
      timestampMs: input.timestampMs,
    });
  }

  playout(input: {
    readonly turnId: TurnId;
    readonly markId: string;
    readonly confirmed: boolean;
    readonly timestampMs: number;
  }): void {
    if (!this.#tap || this.#closed) return;
    const sequence = this.#nextSequence++;
    if (input.markId.length > AUDIO_TAP_MAX_MARK_ID_LENGTH) {
      this.#droppedEvents += 1;
      return;
    }
    const throughSequence = this.#lastAgentAudioByTurn.get(input.turnId);
    if (input.confirmed) this.#lastAgentAudioByTurn.delete(input.turnId);
    this.#control({
      type: "playout",
      direction: "agent",
      sessionId: this.#sessionId,
      turnId: input.turnId,
      markId: input.markId,
      confirmed: input.confirmed,
      ...(throughSequence !== undefined ? { throughSequence } : {}),
      sequence,
      timestampMs: input.timestampMs,
    });
  }

  summary(): AudioTapSummary {
    return {
      enabled: this.#tap !== undefined,
      droppedFrames: this.#droppedFrames,
      droppedEvents: this.#droppedEvents,
      callbackErrors: this.#callbackErrors,
    };
  }

  close(): AudioTapSummary {
    this.#closed = true;
    this.#scheduleDrain();
    this.#scheduleDrainedNotification();
    return this.summary();
  }

  recordDroppedEvents(count: number): void {
    if (this.#tap && Number.isSafeInteger(count) && count > 0) {
      this.#droppedEvents += count;
    }
  }

  recordDroppedFrames(count: number): void {
    if (this.#tap && Number.isSafeInteger(count) && count > 0) {
      this.#droppedFrames += count;
    }
  }

  #control(frame: AudioTapClearedFrame | AudioTapPlayoutFrame): void {
    if (this.#queuedControlEvents >= AUDIO_TAP_MAX_BUFFERED_CONTROL_EVENTS) {
      const oldestControlIndex = this.#queue.findIndex((item) => !item.isAudio);
      if (oldestControlIndex >= 0) {
        this.#queue.splice(oldestControlIndex, 1);
        this.#queuedControlEvents -= 1;
      } else {
        this.#droppedEvents += 1;
        return;
      }
      this.#droppedEvents += 1;
    }
    this.#enqueue(frame, false, 0);
  }

  #enqueue(frame: AudioTapFrame, isAudio: boolean, audioBytes: number): void {
    this.#queue.push({ frame, isAudio, audioBytes });
    if (isAudio) {
      this.#queuedAudioFrames += 1;
      this.#queuedAudioBytes += audioBytes;
    } else {
      this.#queuedControlEvents += 1;
    }
    this.#scheduleDrain();
  }

  #scheduleDrain(): void {
    if (!this.#tap || this.#scheduled || this.#draining || this.#queue.length === 0) return;
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      void this.#drain();
    });
  }

  async #drain(): Promise<void> {
    if (this.#draining || !this.#tap) return;
    this.#draining = true;
    try {
      while (this.#queue.length > 0) {
        const item = this.#queue.shift()!;
        if (item.isAudio) {
          this.#queuedAudioFrames -= 1;
          this.#queuedAudioBytes -= item.audioBytes;
        } else {
          this.#queuedControlEvents -= 1;
        }
        try {
          await this.#tap.onFrame(item.frame);
        } catch {
          this.#callbackErrors += 1;
        }
      }
    } finally {
      this.#draining = false;
      this.#scheduleDrain();
      this.#scheduleDrainedNotification();
    }
  }

  #scheduleDrainedNotification(): void {
    if (
      !this.#closed ||
      !this.#tap?.onDrained ||
      this.#drainedScheduled ||
      this.#drainedNotified ||
      this.#draining ||
      this.#queue.length > 0
    ) {
      return;
    }
    this.#drainedScheduled = true;
    setTimeout(() => {
      this.#drainedScheduled = false;
      if (this.#draining || this.#queue.length > 0) {
        this.#scheduleDrain();
        this.#scheduleDrainedNotification();
        return;
      }
      this.#drainedNotified = true;
      try {
        void Promise.resolve(
          this.#tap?.onDrained?.({ sessionId: this.#sessionId, summary: this.summary() }),
        ).catch(() => undefined);
      } catch {}
    }, 0);
  }
}
