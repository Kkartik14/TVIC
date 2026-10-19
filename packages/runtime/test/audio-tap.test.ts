import { describe, expect, it } from "vitest";

import { PCM16_16K_MONO, type SessionId, type TurnId } from "@tvic/core";
import {
  AUDIO_TAP_MAX_BUFFERED_AUDIO_FRAMES,
  AUDIO_TAP_MAX_BUFFERED_BYTES,
  AUDIO_TAP_MAX_BUFFERED_CONTROL_EVENTS,
  AudioTapDispatcher,
  type AudioTapDrainContext,
  type AudioTapFrame,
} from "../src/audio-tap.js";

const SESSION_ID = "session_audio_tap" as SessionId;

describe("AudioTapDispatcher", () => {
  it("does not count dropped events when the tap is disabled", () => {
    const dispatcher = new AudioTapDispatcher({ sessionId: SESSION_ID });
    dispatcher.recordDroppedEvents(3);
    dispatcher.recordDroppedFrames(2);

    expect(dispatcher.summary()).toEqual({
      enabled: false,
      droppedFrames: 0,
      droppedEvents: 0,
      callbackErrors: 0,
    });
  });

  it("calls class instance tap methods with the tap object as this", async () => {
    class Recorder {
      readonly frames: AudioTapFrame[] = [];
      readonly drains: AudioTapDrainContext[] = [];

      onFrame(frame: AudioTapFrame): void {
        this.frames.push(frame);
      }

      onDrained(context: AudioTapDrainContext): void {
        this.drains.push(context);
      }
    }

    const recorder = new Recorder();
    const dispatcher = new AudioTapDispatcher({
      sessionId: SESSION_ID,
      tap: recorder,
    });
    dispatcher.audio({
      direction: "caller",
      bytes: new Uint8Array([1, 2]),
      format: PCM16_16K_MONO,
      timestampMs: 0,
    });

    dispatcher.close();
    await waitFor(() => recorder.drains.length === 1 || dispatcher.summary().callbackErrors > 0);

    expect(recorder.frames).toHaveLength(1);
    expect(recorder.drains).toHaveLength(1);
    expect(recorder.frames[0]).toMatchObject({
      type: "audio",
      direction: "caller",
      sessionId: SESSION_ID,
    });
    expect(recorder.drains[0]).toMatchObject({ sessionId: SESSION_ID });
    expect(dispatcher.summary()).toMatchObject({ callbackErrors: 0, droppedFrames: 0 });
  });

  it("queues copied audio off the caller stack and counts frames dropped behind a slow consumer", async () => {
    let releaseFirst!: () => void;
    let signalFirst!: () => void;
    const firstFrameStarted = new Promise<void>((resolve) => {
      signalFirst = resolve;
    });
    const firstFrameGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const frames: Uint8Array[] = [];
    const dispatcher = new AudioTapDispatcher({
      sessionId: SESSION_ID,
      tap: {
        onFrame: async (frame) => {
          if (frame.type !== "audio") return;
          frames.push(frame.bytes);
          if (frames.length === 1) {
            signalFirst();
            await firstFrameGate;
          }
        },
      },
    });
    const source = new Uint8Array([1, 2]);

    for (let index = 0; index < AUDIO_TAP_MAX_BUFFERED_AUDIO_FRAMES + 2; index += 1) {
      dispatcher.audio({
        direction: "caller",
        bytes: source,
        format: PCM16_16K_MONO,
        timestampMs: index,
      });
    }

    expect(frames).toEqual([]);
    expect(dispatcher.summary()).toMatchObject({ enabled: true, droppedFrames: 2 });
    source[0] = 9;
    await firstFrameStarted;
    expect(frames[0]).toEqual(new Uint8Array([1, 2]));

    releaseFirst();
    await waitFor(() => frames.length === AUDIO_TAP_MAX_BUFFERED_AUDIO_FRAMES);
    expect(dispatcher.summary().droppedFrames).toBe(2);
    dispatcher.close();
  });

  it("enforces the PCM byte cap while allowing one in-flight frame", async () => {
    let releaseFirst!: () => void;
    let signalFirst!: () => void;
    const firstFrameStarted = new Promise<void>((resolve) => {
      signalFirst = resolve;
    });
    const firstFrameGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const frameSizes: number[] = [];
    const dispatcher = new AudioTapDispatcher({
      sessionId: SESSION_ID,
      tap: {
        async onFrame(frame) {
          if (frame.type !== "audio") return;
          frameSizes.push(frame.bytes.byteLength);
          if (frameSizes.length === 1) {
            signalFirst();
            await firstFrameGate;
          }
        },
      },
    });

    dispatcher.audio({
      direction: "caller",
      bytes: new Uint8Array(AUDIO_TAP_MAX_BUFFERED_BYTES),
      format: PCM16_16K_MONO,
      timestampMs: 0,
    });
    await firstFrameStarted;
    dispatcher.audio({
      direction: "caller",
      bytes: new Uint8Array(AUDIO_TAP_MAX_BUFFERED_BYTES),
      format: PCM16_16K_MONO,
      timestampMs: 1,
    });
    dispatcher.audio({
      direction: "caller",
      bytes: new Uint8Array([1]),
      format: PCM16_16K_MONO,
      timestampMs: 2,
    });

    expect(dispatcher.summary().droppedFrames).toBe(1);
    releaseFirst();
    await waitFor(() => frameSizes.length === 2);
    expect(frameSizes).toEqual([AUDIO_TAP_MAX_BUFFERED_BYTES, AUDIO_TAP_MAX_BUFFERED_BYTES]);

    dispatcher.audio({
      direction: "caller",
      bytes: new Uint8Array(AUDIO_TAP_MAX_BUFFERED_BYTES + 1),
      format: PCM16_16K_MONO,
      timestampMs: 3,
    });
    expect(dispatcher.summary().droppedFrames).toBe(2);
    dispatcher.close();
  });

  it("drops the oldest control event at the control queue limit and preserves audio", async () => {
    let releaseFirst!: () => void;
    let signalFirst!: () => void;
    const firstFrameStarted = new Promise<void>((resolve) => {
      signalFirst = resolve;
    });
    const firstFrameGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const frames: AudioTapFrame[] = [];
    const dispatcher = new AudioTapDispatcher({
      sessionId: SESSION_ID,
      tap: {
        async onFrame(frame) {
          frames.push(frame);
          if (frames.length === 1) {
            signalFirst();
            await firstFrameGate;
          }
        },
      },
    });

    dispatcher.audio({
      direction: "caller",
      bytes: new Uint8Array([1, 2]),
      format: PCM16_16K_MONO,
      timestampMs: 0,
    });
    await firstFrameStarted;
    for (let index = 0; index < AUDIO_TAP_MAX_BUFFERED_CONTROL_EVENTS + 1; index += 1) {
      dispatcher.cleared({ timestampMs: index + 1 });
    }

    expect(dispatcher.summary()).toMatchObject({ droppedFrames: 0, droppedEvents: 1 });
    releaseFirst();
    await waitFor(() => frames.length === AUDIO_TAP_MAX_BUFFERED_CONTROL_EVENTS + 1);
    expect(frames.map((frame) => frame.sequence)).toEqual([
      0,
      ...Array.from({ length: AUDIO_TAP_MAX_BUFFERED_CONTROL_EVENTS }, (_, index) => index + 2),
    ]);
    expect(frames[0]?.type).toBe("audio");
    expect(frames.slice(1).every((frame) => frame.type === "cleared")).toBe(true);
    dispatcher.close();
  });

  it("catches and counts a consumer exception without stopping later frames", async () => {
    let delivered!: () => void;
    const threeFramesDelivered = new Promise<void>((resolve) => {
      delivered = resolve;
    });
    const seen: number[] = [];
    const dispatcher = new AudioTapDispatcher({
      sessionId: SESSION_ID,
      tap: {
        onFrame(frame) {
          if (frame.type !== "audio") return;
          seen.push(frame.sequence);
          if (seen.length === 1) throw new Error("recording sink failed");
          if (seen.length === 3) delivered();
        },
      },
    });

    for (let index = 0; index < 3; index += 1) {
      dispatcher.audio({
        direction: "caller",
        bytes: new Uint8Array([index]),
        format: PCM16_16K_MONO,
        timestampMs: index,
      });
    }

    await threeFramesDelivered;
    expect(seen).toEqual([0, 1, 2]);
    expect(dispatcher.summary()).toMatchObject({ callbackErrors: 1, droppedFrames: 0 });
    dispatcher.close();
  });

  it("does not count bounded turn-history eviction as a dropped tap event", async () => {
    const frames: AudioTapFrame[] = [];
    const dispatcher = new AudioTapDispatcher({
      sessionId: SESSION_ID,
      tap: {
        onFrame(frame) {
          frames.push(frame);
        },
      },
    });
    const turns = Array.from(
      { length: AUDIO_TAP_MAX_BUFFERED_AUDIO_FRAMES + 1 },
      (_, index) => `turn_audio_tap_${index}` as TurnId,
    );

    for (const [index, turnId] of turns.entries()) {
      dispatcher.audio({
        direction: "agent",
        turnId,
        bytes: new Uint8Array([index % 256]),
        format: PCM16_16K_MONO,
        timestampMs: index,
      });
      await waitFor(() =>
        frames.some((frame) => frame.type === "audio" && frame.turnId === turnId),
      );
    }

    expect(dispatcher.summary()).toMatchObject({ droppedFrames: 0, droppedEvents: 0 });
    const oldestTurn = turns[0]!;
    dispatcher.cleared({ turnId: oldestTurn, timestampMs: turns.length });
    await waitFor(() =>
      frames.some((frame) => frame.type === "cleared" && frame.turnId === oldestTurn),
    );

    const cleared = frames.find((frame) => frame.type === "cleared" && frame.turnId === oldestTurn);
    expect(cleared).not.toHaveProperty("throughSequence");
    expect(dispatcher.summary().droppedEvents).toBe(0);
    dispatcher.close();
  });

  it("retains the session-wide agent watermark after confirmed playout", () => {
    const dispatcher = new AudioTapDispatcher({
      sessionId: SESSION_ID,
      tap: { onFrame: () => undefined },
    });
    const turnId = "turn_audio_tap_confirmed" as TurnId;
    const audioSequence = dispatcher.audio({
      direction: "agent",
      turnId,
      bytes: new Uint8Array([1, 2]),
      format: PCM16_16K_MONO,
      timestampMs: 0,
    });
    dispatcher.playout({
      turnId,
      markId: "mark_audio_tap_confirmed",
      confirmed: true,
      timestampMs: 1,
    });

    expect(dispatcher.agentAudioThroughSequence()).toBe(audioSequence);
    dispatcher.close();
  });

  it("applies a global clear boundary across turns but preserves later audio", () => {
    const dispatcher = new AudioTapDispatcher({
      sessionId: SESSION_ID,
      tap: { onFrame: () => undefined },
    });
    const earlierTurn = "turn_audio_tap_earlier" as TurnId;
    const requestingTurn = "turn_audio_tap_requester" as TurnId;
    const laterTurn = "turn_audio_tap_later" as TurnId;
    dispatcher.audio({
      direction: "agent",
      turnId: earlierTurn,
      bytes: new Uint8Array([1]),
      format: PCM16_16K_MONO,
      timestampMs: 0,
    });
    dispatcher.audio({
      direction: "agent",
      turnId: requestingTurn,
      bytes: new Uint8Array([2]),
      format: PCM16_16K_MONO,
      timestampMs: 1,
    });
    const clearBoundary = dispatcher.agentAudioThroughSequence();
    const laterSequence = dispatcher.audio({
      direction: "agent",
      turnId: laterTurn,
      bytes: new Uint8Array([3]),
      format: PCM16_16K_MONO,
      timestampMs: 2,
    });

    dispatcher.cleared({
      turnId: requestingTurn,
      throughSequence: clearBoundary,
      timestampMs: 3,
    });

    expect(dispatcher.agentAudioThroughSequence(earlierTurn)).toBeUndefined();
    expect(dispatcher.agentAudioThroughSequence(requestingTurn)).toBeUndefined();
    expect(dispatcher.agentAudioThroughSequence(laterTurn)).toBe(laterSequence);
    dispatcher.close();
  });

  it("counts an oversized playout marker as a dropped control event", async () => {
    let releaseFirst!: () => void;
    let signalFirst!: () => void;
    const firstFrameStarted = new Promise<void>((resolve) => {
      signalFirst = resolve;
    });
    const firstFrameGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const events: string[] = [];
    const dispatcher = new AudioTapDispatcher({
      sessionId: SESSION_ID,
      tap: {
        async onFrame(frame) {
          events.push(frame.type);
          if (events.length === 1) {
            signalFirst();
            await firstFrameGate;
          }
        },
      },
    });

    dispatcher.audio({
      direction: "agent",
      turnId: "turn_audio_tap" as never,
      bytes: new Uint8Array([1, 2]),
      format: PCM16_16K_MONO,
      timestampMs: 0,
    });
    await firstFrameStarted;
    dispatcher.playout({
      turnId: "turn_audio_tap" as never,
      markId: "m".repeat(1_024),
      confirmed: true,
      timestampMs: 1,
    });

    expect(dispatcher.summary().droppedEvents).toBe(1);
    releaseFirst();
    dispatcher.close();
  });

  it("keeps the last accepted audio sequence when an oversized playout marker is dropped", async () => {
    const frames: Array<{ readonly type: string; readonly throughSequence?: number }> = [];
    const dispatcher = new AudioTapDispatcher({
      sessionId: SESSION_ID,
      tap: {
        onFrame(frame) {
          frames.push(frame);
        },
      },
    });
    const turnId = "turn_audio_tap" as never;

    dispatcher.audio({
      direction: "agent",
      turnId,
      bytes: new Uint8Array([1, 2]),
      format: PCM16_16K_MONO,
      timestampMs: 0,
    });
    dispatcher.playout({
      turnId,
      markId: "m".repeat(1_024),
      confirmed: true,
      timestampMs: 1,
    });
    dispatcher.cleared({ turnId, timestampMs: 2 });
    dispatcher.close();

    await waitFor(() => frames.some((frame) => frame.type === "cleared"));
    expect(frames.find((frame) => frame.type === "cleared")?.throughSequence).toBe(0);
    expect(dispatcher.summary().droppedEvents).toBe(1);
  });

  it("keeps audio accepted after a clear request beyond that clear boundary", async () => {
    const frames: Array<{ readonly type: string; readonly throughSequence?: number }> = [];
    const dispatcher = new AudioTapDispatcher({
      sessionId: SESSION_ID,
      tap: {
        onFrame(frame) {
          frames.push(frame);
        },
      },
    });
    const turnId = "turn_audio_tap" as never;
    const firstSequence = dispatcher.audio({
      direction: "agent",
      turnId,
      bytes: new Uint8Array([1, 2]),
      format: PCM16_16K_MONO,
      timestampMs: 0,
    });
    const clearBoundary = dispatcher.agentAudioThroughSequence(turnId);
    const laterSequence = dispatcher.audio({
      direction: "agent",
      turnId,
      bytes: new Uint8Array([3, 4]),
      format: PCM16_16K_MONO,
      timestampMs: 2,
    });

    dispatcher.cleared({ turnId, throughSequence: clearBoundary, timestampMs: 1 });
    dispatcher.cleared({ turnId, timestampMs: 3 });
    dispatcher.close();

    await waitFor(() => frames.filter((frame) => frame.type === "cleared").length === 2);
    expect(frames.filter((frame) => frame.type === "cleared")).toEqual([
      expect.objectContaining({ type: "cleared", throughSequence: firstSequence }),
      expect.objectContaining({ type: "cleared", throughSequence: laterSequence }),
    ]);
  });

  it("keeps final counters as a close-time snapshot while catching a late rejection", async () => {
    let releaseFrame!: () => void;
    let signalFrame!: () => void;
    const frameStarted = new Promise<void>((resolve) => {
      signalFrame = resolve;
    });
    const frameGate = new Promise<void>((resolve) => {
      releaseFrame = resolve;
    });
    const dispatcher = new AudioTapDispatcher({
      sessionId: SESSION_ID,
      tap: {
        async onFrame() {
          signalFrame();
          await frameGate;
          throw new Error("late sink failure");
        },
      },
    });
    dispatcher.audio({
      direction: "caller",
      bytes: new Uint8Array([1, 2]),
      format: PCM16_16K_MONO,
      timestampMs: 0,
    });
    await frameStarted;

    const finalSnapshot = dispatcher.close();
    expect(finalSnapshot.callbackErrors).toBe(0);
    releaseFrame();
    await waitFor(() => dispatcher.summary().callbackErrors === 1);
    expect(finalSnapshot.callbackErrors).toBe(0);
  });

  it("signals when closed tap delivery drains and reports callback failures seen during drain", async () => {
    let releaseFirst!: () => void;
    let signalFirst!: () => void;
    const firstFrameStarted = new Promise<void>((resolve) => {
      signalFirst = resolve;
    });
    const firstFrameGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const seen: number[] = [];
    let drainedContext: AudioTapDrainContext | undefined;
    const dispatcher = new AudioTapDispatcher({
      sessionId: SESSION_ID,
      tap: {
        async onFrame(frame) {
          if (frame.type !== "audio") return;
          seen.push(frame.sequence);
          if (seen.length === 1) {
            signalFirst();
            await firstFrameGate;
          } else {
            throw new Error("second frame failed");
          }
        },
        onDrained(context: AudioTapDrainContext) {
          drainedContext = context;
        },
      },
    });

    dispatcher.audio({
      direction: "caller",
      bytes: new Uint8Array([1, 2]),
      format: PCM16_16K_MONO,
      timestampMs: 0,
    });
    dispatcher.audio({
      direction: "caller",
      bytes: new Uint8Array([3, 4]),
      format: PCM16_16K_MONO,
      timestampMs: 1,
    });
    await firstFrameStarted;

    const closeSnapshot = dispatcher.close();

    expect(drainedContext).toBeUndefined();
    releaseFirst();
    await waitFor(() => drainedContext !== undefined);

    expect(seen).toEqual([0, 1]);
    expect(closeSnapshot.callbackErrors).toBe(0);
    expect(drainedContext).toMatchObject({
      sessionId: SESSION_ID,
      summary: { enabled: true, callbackErrors: 1 },
    });
  });

  it("defers an empty drain notification until after close returns and includes the session ID", async () => {
    let drainedContext: AudioTapDrainContext | undefined;
    let signalDrained!: () => void;
    const drained = new Promise<void>((resolve) => {
      signalDrained = resolve;
    });
    const dispatcher = new AudioTapDispatcher({
      sessionId: SESSION_ID,
      tap: {
        onFrame() {},
        onDrained(context) {
          drainedContext = context;
          signalDrained();
        },
      },
    });

    const closeSummary = dispatcher.close();
    expect(drainedContext).toBeUndefined();
    await Promise.resolve();
    expect(drainedContext).toBeUndefined();
    await drained;

    expect(drainedContext).toEqual({ sessionId: SESSION_ID, summary: closeSummary });
  });

  it("contains onDrained throws and rejections outside the callback error summary", async () => {
    const summaries: AudioTapDrainContext["summary"][] = [];
    let signalDrained!: () => void;
    const drained = new Promise<void>((resolve) => {
      signalDrained = resolve;
    });
    const recordSummary = (context: AudioTapDrainContext): void => {
      summaries.push(context.summary);
      if (summaries.length === 2) signalDrained();
    };
    const throwing = new AudioTapDispatcher({
      sessionId: SESSION_ID,
      tap: {
        onFrame() {},
        onDrained(context) {
          recordSummary(context);
          throw new Error("synchronous drain failure");
        },
      },
    });
    const rejecting = new AudioTapDispatcher({
      sessionId: `${SESSION_ID}_rejecting` as SessionId,
      tap: {
        onFrame() {},
        onDrained(context) {
          recordSummary(context);
          return Promise.reject(new Error("asynchronous drain failure"));
        },
      },
    });

    expect(() => throwing.close()).not.toThrow();
    expect(() => rejecting.close()).not.toThrow();
    await drained;
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(summaries).toHaveLength(2);
    expect(summaries).toEqual([
      { enabled: true, droppedFrames: 0, droppedEvents: 0, callbackErrors: 0 },
      { enabled: true, droppedFrames: 0, droppedEvents: 0, callbackErrors: 0 },
    ]);
  });

  it("signals an empty drain once and never waits for an unsettled frame callback", async () => {
    let drainSignals = 0;
    let releaseFrame!: () => void;
    let signalFrameStarted!: () => void;
    let signalDrained!: () => void;
    const frameGate = new Promise<void>((resolve) => {
      releaseFrame = resolve;
    });
    const frameStarted = new Promise<void>((resolve) => {
      signalFrameStarted = resolve;
    });
    const drained = new Promise<void>((resolve) => {
      signalDrained = resolve;
    });
    const dispatcher = new AudioTapDispatcher({
      sessionId: SESSION_ID,
      tap: {
        async onFrame() {
          signalFrameStarted();
          await frameGate;
        },
        onDrained() {
          drainSignals += 1;
          signalDrained();
        },
      },
    });

    dispatcher.audio({
      direction: "caller",
      bytes: new Uint8Array([1, 2]),
      format: PCM16_16K_MONO,
      timestampMs: 0,
    });
    await frameStarted;
    dispatcher.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(drainSignals).toBe(0);

    releaseFrame();
    await drained;
    expect(drainSignals).toBe(1);

    dispatcher.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(drainSignals).toBe(1);
  });

  it("forwards clear and playout events in tap sequence order", async () => {
    let delivered!: () => void;
    const threeEventsDelivered = new Promise<void>((resolve) => {
      delivered = resolve;
    });
    const events: Array<{ readonly type: string; readonly sequence: number }> = [];
    const dispatcher = new AudioTapDispatcher({
      sessionId: SESSION_ID,
      tap: {
        onFrame(frame) {
          events.push({ type: frame.type, sequence: frame.sequence });
          if (events.length === 3) delivered();
        },
      },
    });

    const audioSequence = dispatcher.audio({
      direction: "agent",
      turnId: "turn_audio_tap" as never,
      bytes: new Uint8Array([1, 2]),
      format: PCM16_16K_MONO,
      timestampMs: 10,
    });
    dispatcher.cleared({
      turnId: "turn_audio_tap" as never,
      timestampMs: 11,
    });
    dispatcher.playout({
      turnId: "turn_audio_tap" as never,
      markId: "mark_audio_tap",
      confirmed: true,
      timestampMs: 12,
    });

    await threeEventsDelivered;
    expect(audioSequence).toBe(0);
    expect(events).toEqual([
      { type: "audio", sequence: 0 },
      { type: "cleared", sequence: 1 },
      { type: "playout", sequence: 2 },
    ]);
    dispatcher.close();
  });

  it("keeps sent audio sequence attached to a clear after unconfirmed playout", async () => {
    let delivered!: () => void;
    const threeEventsDelivered = new Promise<void>((resolve) => {
      delivered = resolve;
    });
    const frames: Array<{ readonly type: string; readonly throughSequence?: number }> = [];
    const dispatcher = new AudioTapDispatcher({
      sessionId: SESSION_ID,
      tap: {
        onFrame(frame) {
          frames.push(frame);
          if (frames.length === 3) delivered();
        },
      },
    });
    const turnId = "turn_audio_tap" as never;

    dispatcher.audio({
      direction: "agent",
      turnId,
      bytes: new Uint8Array([1, 2]),
      format: PCM16_16K_MONO,
      timestampMs: 10,
    });
    dispatcher.playout({
      turnId,
      markId: "mark_audio_tap",
      confirmed: false,
      timestampMs: 11,
    });
    dispatcher.cleared({ turnId, timestampMs: 12 });

    await threeEventsDelivered;
    expect(frames[2]).toMatchObject({ type: "cleared", throughSequence: 0 });
    dispatcher.close();
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition was not reached before timeout");
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
}
