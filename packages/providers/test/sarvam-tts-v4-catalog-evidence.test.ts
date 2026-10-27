import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  SARVAM_TTS_V4_FLASH_PUBLIC_VOICE_CASES,
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

interface RosterProbeEvidence {
  readonly observedAt: string;
  readonly model: string;
  readonly probes: readonly {
    readonly speaker: string;
    readonly language: string;
    readonly httpStatus: number;
    readonly audioBytes?: number;
    readonly providerCode?: string;
  }[];
}

const evidence = JSON.parse(
  readFileSync(new URL("./sarvam-tts-v4-catalog-probe-2026-10-11.json", import.meta.url), "utf8"),
) as CatalogProbeEvidence;

const rosterEvidence = JSON.parse(
  readFileSync(new URL("./sarvam-tts-v4-catalog-probe-2026-10-28.json", import.meta.url), "utf8"),
) as RosterProbeEvidence;

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

  it("lists the Assamese roster personas the tested account synthesized", () => {
    expect(rosterEvidence.model).toBe("bulbul:v4-flash");
    expect(rosterEvidence.observedAt).toBe("2026-10-28");
    const synthesized = rosterEvidence.probes.filter(({ httpStatus }) => httpStatus === 200);
    expect(synthesized.map(({ speaker }) => speaker).sort()).toEqual([
      "kangkana_as_conversational",
      "mouchumi_as_conversational",
    ]);
    for (const probe of synthesized) {
      expect(probe.audioBytes).toBeGreaterThan(0);
      expect(SARVAM_TTS_V4_FLASH_VOICES).toContain(probe.speaker);
      expect(
        SARVAM_TTS_V4_FLASH_PUBLIC_VOICE_CASES.find(({ voice }) => voice === probe.speaker),
      ).toMatchObject({ language: probe.language });
    }
  });
});
