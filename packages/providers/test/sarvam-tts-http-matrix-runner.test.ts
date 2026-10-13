import { afterEach, describe, expect, it, vi } from "vitest";

import { pcm16ToWav, StartPacer } from "../../../scripts/sarvam-tts-http-live-common.js";
import { runWithRetries } from "../../../scripts/sarvam-tts-http-matrix.js";
import { createSarvamTtsHttpMatrixJobs } from "../../../scripts/sarvam-tts-matrix-jobs.js";
import { SARVAM_TTS_V4_FLASH_MODEL } from "../src/sarvam-tts-v4-voices.js";

describe("Sarvam HTTP matrix runner", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("runs the documented V4 cross-language case metrics-only when artifacts are disabled", async () => {
    const job = createSarvamTtsHttpMatrixJobs(
      SARVAM_TTS_V4_FLASH_MODEL,
      ["http-stream"],
      ["simran_en_customer"],
      ["hi-IN"],
    )[0];
    if (!job) throw new Error("expected documented V4 matrix job");

    let requestBody: Record<string, unknown> | undefined;
    const audio = new Uint8Array(640).fill(7);
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(pcm16ToWav(audio), {
        status: 200,
        headers: { "content-type": "audio/wav" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await runWithRetries(
      job,
      "sarvam-test-key",
      2_000,
      0,
      0,
      0,
      new StartPacer(0),
      () => undefined,
      false,
    );

    expect(requestBody).toMatchObject({
      model: SARVAM_TTS_V4_FLASH_MODEL,
      speaker: "simran_en_customer",
      language_code: "hi-IN",
    });
    expect(result.synthesis).toEqual({ audioBytes: 640, chunks: 1, durationMs: 20 });
    expect(result.synthesis).not.toHaveProperty("bytes");
  });
});
