import { describe, expect, it } from "vitest";

import {
  PCM16_16K_MONO,
  providerError,
  STT_ERROR_CODES,
  type InputAudioChunk,
  type SessionId,
  type SttStream,
  type TranscriptEvent,
} from "@tvic/core";
import { AsyncQueue } from "@tvic/media";

import { SerialSttCommandController } from "../src/stt-command-controller.js";

describe("SerialSttCommandController", () => {
  it("keeps admitting audio while a commit is blocked and preserves the barrier order", async () => {
    const order: string[] = [];
    const events = new AsyncQueue<TranscriptEvent>();
    let commitStarted = false;
    let releaseCommit: (() => void) | undefined;
    const stream = makeStream({
      events,
      sendAudio: async (chunk) => {
        order.push(`audio:${chunk.audio.bytes[0] ?? 0}`);
      },
      commit: async () => {
        order.push("commit");
        commitStarted = true;
        await new Promise<void>((resolve) => {
          releaseCommit = resolve;
        });
      },
    });
    const controller = new SerialSttCommandController({ stream });

    await controller.admitAudio(audioChunk(1));
    const commit = controller.admitCommit();
    await waitFor(() => commitStarted);
    await controller.admitAudio(audioChunk(2));

    expect(order).toEqual(["audio:1", "commit"]);

    releaseCommit?.();
    await commit;
    await controller.drain();

    expect(order).toEqual(["audio:1", "commit", "audio:2"]);
  });

  it("aborts a blocked commit and closes without waiting for provider settlement", async () => {
    const events = new AsyncQueue<TranscriptEvent>();
    let commitStarted = false;
    let closeCalls = 0;
    const stream = makeStream({
      events,
      commit: async () => {
        commitStarted = true;
        await new Promise<void>(() => undefined);
      },
      close: async () => {
        closeCalls += 1;
      },
    });
    const controller = new SerialSttCommandController({ stream });
    const commit = controller.admitCommit();
    await waitFor(() => commitStarted);

    const error = providerError("stt.reconnect.closed", "caller hung up", { retriable: false });
    const abort = controller.abort(error);

    await expect(abort).resolves.toBeUndefined();
    await expect(commit).rejects.toBe(error);
    expect(closeCalls).toBe(1);
  });

  it("supervises provider send failure and closes the stream", async () => {
    const events = new AsyncQueue<TranscriptEvent>();
    let closeCalls = 0;
    const error = providerError("stt.transport.write_failed", "write failed", {
      retriable: true,
    });
    const stream = makeStream({
      events,
      sendAudio: async () => {
        throw error;
      },
      close: async () => {
        closeCalls += 1;
      },
    });
    const controller = new SerialSttCommandController({ stream });
    const failure = expect(controller.failure).rejects.toBe(error);

    await controller.admitAudio(audioChunk(1));
    await failure;

    expect(closeCalls).toBe(1);
    await expect(controller.admitAudio(audioChunk(2))).rejects.toMatchObject({
      code: STT_ERROR_CODES.closed,
    });
  });
});

interface StreamOptions {
  readonly events: AsyncQueue<TranscriptEvent>;
  readonly sendAudio?: (chunk: InputAudioChunk) => Promise<void>;
  readonly commit?: () => Promise<void>;
  readonly close?: () => Promise<void>;
}

function makeStream(options: StreamOptions): SttStream {
  return {
    events: options.events,
    async sendAudio(chunk) {
      await options.sendAudio?.(chunk);
    },
    async commit() {
      await options.commit?.();
    },
    async close() {
      await options.close?.();
    },
  };
}

function audioChunk(value: number): InputAudioChunk {
  return {
    id: `controller_audio_${value}` as never,
    type: "media.audio.chunk",
    sessionId: "controller_session" as SessionId,
    sequence: value,
    direction: "input",
    timestamp: "2026-08-29T00:00:00.000Z" as never,
    monotonicOffsetMs: value,
    audio: {
      format: PCM16_16K_MONO,
      durationMs: 1,
      frameCount: 1,
      bytes: new Uint8Array([value]),
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for STT controller state");
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
