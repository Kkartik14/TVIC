import { afterEach, describe, expect, it, vi } from "vitest";

import {
  pcm16ToWav,
  synthesizeSarvamHttpAudio,
  withTimeout,
} from "../../../scripts/sarvam-tts-http-live-common.js";

describe("Sarvam HTTP live audio collector", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("keeps a timed-out operation rejected while asynchronous cleanup is pending", async () => {
    vi.useFakeTimers();
    let resolveOperation!: () => void;
    let resolveCleanup!: () => void;
    const operation = new Promise<void>((resolve) => {
      resolveOperation = resolve;
    });
    const cleanup = new Promise<void>((resolve) => {
      resolveCleanup = resolve;
    });

    const timedOperation = withTimeout(operation, 25, () => cleanup);
    const rejection = expect(timedOperation).rejects.toThrow("operation timed out after 25ms");
    await vi.advanceTimersByTimeAsync(25);
    resolveOperation();
    resolveCleanup();

    await rejection;
  });

  it("does not leak a rejected asynchronous timeout cleanup", async () => {
    vi.useFakeTimers();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const timedOperation = withTimeout(new Promise<void>(() => undefined), 25, () =>
        Promise.reject(new Error("cleanup failed")),
      );
      const rejection = expect(timedOperation).rejects.toThrow("operation timed out after 25ms");
      await vi.advanceTimersByTimeAsync(25);
      await rejection;
      vi.useRealTimers();
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("returns bounded audio metrics without retaining PCM when collection is disabled", async () => {
    const pcm = new Uint8Array(640).fill(3);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ audios: [pcm16ToWav(pcm).toString("base64")] }), {
            status: 200,
          }),
      ),
    );

    const metrics = await synthesizeSarvamHttpAudio({
      apiKey: "sarvam-test-key",
      transport: "rest",
      model: "bulbul:v3",
      voice: "shubh",
      language: "en-IN",
      text: "A bounded audio collector test.",
      sessionId: "collector-session",
      turnId: "collector-turn",
      timeoutMs: 2_000,
      collectAudio: false,
    });

    expect(metrics).toEqual({ audioBytes: 640, chunks: 1, durationMs: 20 });
    expect(metrics).not.toHaveProperty("bytes");
  });

  it("writes a canonical WAV into one independent output allocation", () => {
    const pcm = new Uint8Array([1, 2, 3, 4]);
    const from = vi.spyOn(Buffer, "from");
    const concat = vi.spyOn(Buffer, "concat");
    try {
      const wav = pcm16ToWav(pcm);

      expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
      expect(wav.readUInt32LE(4)).toBe(40);
      expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
      expect(wav.toString("ascii", 36, 40)).toBe("data");
      expect(wav.readUInt32LE(40)).toBe(4);
      expect([...wav.subarray(44)]).toEqual([1, 2, 3, 4]);
      expect(from.mock.calls.some(([value]) => value === pcm)).toBe(false);
      expect(concat).not.toHaveBeenCalled();

      pcm.fill(0);
      expect([...wav.subarray(44)]).toEqual([1, 2, 3, 4]);
    } finally {
      from.mockRestore();
      concat.mockRestore();
    }
  });
});
