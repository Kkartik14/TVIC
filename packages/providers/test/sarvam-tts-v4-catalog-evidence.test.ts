import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  SARVAM_TTS_V4_FLASH_UNVERIFIED_ROSTER_VOICES,
  SARVAM_TTS_V4_FLASH_VOICES,
} from "../src/sarvam-tts-v4-voices.js";

interface CatalogProbeEvidence {
  readonly observedAt: string;
  readonly model: string;
  readonly probes: readonly {
    readonly speaker: string;
    readonly language: string;
    readonly httpStatus: number;
    readonly providerCode?: string;
    readonly controlSpeaker?: string;
  }[];
}

const evidence = JSON.parse(
  readFileSync(new URL("./sarvam-tts-v4-catalog-probe-2026-10-11.json", import.meta.url), "utf8"),
) as CatalogProbeEvidence;

describe("dated Sarvam V4 live catalog evidence", () => {
  it("keeps live-accepted personas in the dated V4 catalog snapshot", () => {
    const catalog = SARVAM_TTS_V4_FLASH_VOICES;

    expect(evidence.model).toBe("bulbul:v4-flash");
    expect(evidence.observedAt).toBe("2026-10-11");
    for (const probe of evidence.probes.filter(({ httpStatus }) => httpStatus === 200)) {
      expect(catalog).toContain(probe.speaker);
    }
  });

  it("does not add IDs the tested account rejected to the V4 catalog snapshot", () => {
    const catalog = SARVAM_TTS_V4_FLASH_VOICES;

    for (const probe of evidence.probes.filter(({ httpStatus }) => httpStatus === 400)) {
      expect(probe.providerCode).toBe("invalid_request_error");
      expect(catalog).not.toContain(probe.speaker);
      expect(catalog).toContain(probe.controlSpeaker);
      const control = evidence.probes.find(({ speaker }) => speaker === probe.controlSpeaker);
      expect(control).toMatchObject({ httpStatus: 200, language: probe.language });
    }
  });

  it("keeps unverified Assamese roster IDs outside the supported V4 persona catalog", () => {
    for (const voice of SARVAM_TTS_V4_FLASH_UNVERIFIED_ROSTER_VOICES) {
      expect(SARVAM_TTS_V4_FLASH_VOICES).not.toContain(voice);
    }
  });
});
