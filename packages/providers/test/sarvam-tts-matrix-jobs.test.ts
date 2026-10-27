import { describe, expect, it } from "vitest";

import { SARVAM_TTS_V4_FLASH_MODEL } from "../src/index.js";
import {
  createSarvamTtsHttpMatrixJobs as createHttpJobs,
  createSarvamTtsLiveMatrixJobs as createLiveJobs,
  createSarvamTtsMatrixArtifactFile,
} from "../../../scripts/sarvam-tts-matrix-jobs.js";
import { SARVAM_TTS_SAMPLE_TEXT } from "../../../scripts/sarvam-tts-sample-text.js";
import {
  SARVAM_TTS_V4_FLASH_PUBLIC_VOICE_CASES,
  SARVAM_TTS_V4_FLASH_VOICES,
} from "../src/sarvam-tts-v4-voices.js";

describe("Sarvam Bulbul v4 live matrix jobs", () => {
  it("keeps the accepted roster free of duplicates", () => {
    expect(SARVAM_TTS_V4_FLASH_VOICES).toHaveLength(224);
    expect(new Set(SARVAM_TTS_V4_FLASH_VOICES).size).toBe(224);
  });

  it("builds the random-sample pool from the accepted roster only", () => {
    expect(SARVAM_TTS_V4_FLASH_PUBLIC_VOICE_CASES).toHaveLength(224);
    expect(
      SARVAM_TTS_V4_FLASH_PUBLIC_VOICE_CASES.every(
        ({ voice, language }) =>
          SARVAM_TTS_V4_FLASH_VOICES.includes(
            voice as (typeof SARVAM_TTS_V4_FLASH_VOICES)[number],
          ) && language in SARVAM_TTS_SAMPLE_TEXT,
      ),
    ).toBe(true);
  });

  it("tracks the live-accepted Bengali and Tamil personas over the stale docs aliases", () => {
    expect(SARVAM_TTS_V4_FLASH_VOICES).toContain("arnab_bn_conversation");
    expect(SARVAM_TTS_V4_FLASH_VOICES).toContain("aravind_ta_ads");
    expect(SARVAM_TTS_V4_FLASH_VOICES).toContain("aravind_ta_suspense");
    expect(SARVAM_TTS_V4_FLASH_VOICES).not.toContain("bappa_bn_conversation");
    expect(SARVAM_TTS_V4_FLASH_VOICES).not.toContain("vetri_ta_ads");
    expect(SARVAM_TTS_V4_FLASH_VOICES).not.toContain("vetri_ta_suspense");
  });

  it.each(["kangkana_as_conversational", "mouchumi_as_conversational"] as const)(
    "includes Assamese roster persona %s in executable matrix jobs under en-IN",
    (voice) => {
      expect(createLiveJobs(SARVAM_TTS_V4_FLASH_MODEL, [voice], ["en-IN"])).toHaveLength(1);
      expect(
        createHttpJobs(SARVAM_TTS_V4_FLASH_MODEL, ["rest", "http-stream"], [voice], ["en-IN"]),
      ).toHaveLength(2);
    },
  );

  it("rejects unsupported models before building either matrix's jobs", () => {
    expect(() => createLiveJobs("bulbul:v5-preview", ["shubh"], ["en-IN"])).toThrow(
      /unsupported Sarvam TTS model/u,
    );
    expect(() => createHttpJobs("bulbul:v5-preview", ["rest"], ["shubh"], ["en-IN"])).toThrow(
      /unsupported Sarvam TTS model/u,
    );
  });

  it("uses stable audio filenames independent of matrix case ordering", () => {
    const liveJob = createLiveJobs(SARVAM_TTS_V4_FLASH_MODEL, ["simran_en_customer"], ["en-IN"])[0];
    const httpJob = createHttpJobs(
      SARVAM_TTS_V4_FLASH_MODEL,
      ["http-stream"],
      ["simran_en_customer"],
      ["en-IN"],
    )[0];

    expect(liveJob?.file).toMatch(/^bulbul-v4-flash-simran_en_customer-en-IN-[a-f0-9]{64}\.wav$/u);
    expect(httpJob?.file).toMatch(
      /^bulbul-v4-flash-http-stream-simran_en_customer-en-IN-[a-f0-9]{64}\.wav$/u,
    );
    expect(liveJob?.file).toBe(
      createSarvamTtsMatrixArtifactFile(
        SARVAM_TTS_V4_FLASH_MODEL,
        "simran_en_customer",
        "en-IN",
        liveJob?.text ?? "",
      ),
    );
    expect(
      createSarvamTtsMatrixArtifactFile(
        SARVAM_TTS_V4_FLASH_MODEL,
        "simran_en_customer",
        "en-IN",
        `${liveJob?.text} changed`,
      ),
    ).not.toBe(liveJob?.file);
    expect(httpJob?.file).toBe(
      createSarvamTtsMatrixArtifactFile(
        SARVAM_TTS_V4_FLASH_MODEL,
        "simran_en_customer",
        "en-IN",
        httpJob?.text ?? "",
        "http-stream",
      ),
    );
  });

  it("includes Sarvam's documented Hindi request for an English persona in HTTP streaming", () => {
    const jobs = createHttpJobs(
      SARVAM_TTS_V4_FLASH_MODEL,
      ["rest", "http-stream"],
      ["simran_en_customer"],
      ["hi-IN"],
    );

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      transport: "http-stream",
      voice: "simran_en_customer",
      language: "hi-IN",
      text: SARVAM_TTS_SAMPLE_TEXT["hi-IN"],
    });
  });

  it("covers Sarvam's documented English use of a Hindi persona on all transports", () => {
    const websocketJobs = createLiveJobs(
      SARVAM_TTS_V4_FLASH_MODEL,
      ["aparna_hi_customer"],
      ["en-IN"],
    );
    const httpJobs = createHttpJobs(
      SARVAM_TTS_V4_FLASH_MODEL,
      ["rest", "http-stream"],
      ["aparna_hi_customer"],
      ["en-IN"],
    );

    expect(websocketJobs).toEqual([
      expect.objectContaining({
        voice: "aparna_hi_customer",
        language: "en-IN",
        text: SARVAM_TTS_SAMPLE_TEXT["en-IN"],
      }),
    ]);
    expect(
      httpJobs.map(({ transport, voice, language, text }) => ({
        transport,
        voice,
        language,
        text,
      })),
    ).toEqual([
      {
        transport: "rest",
        voice: "aparna_hi_customer",
        language: "en-IN",
        text: SARVAM_TTS_SAMPLE_TEXT["en-IN"],
      },
      {
        transport: "http-stream",
        voice: "aparna_hi_customer",
        language: "en-IN",
        text: SARVAM_TTS_SAMPLE_TEXT["en-IN"],
      },
    ]);
    expect(new Set([...websocketJobs, ...httpJobs].map(({ file }) => file)).size).toBe(3);
  });
});
