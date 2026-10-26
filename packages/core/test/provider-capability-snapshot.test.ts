import { describe, expect, it } from "vitest";

import {
  createProviderCapabilitySnapshot,
  createProviderCapabilitySnapshots,
  MAX_PROVIDER_CAPABILITY_FACTS,
  MAX_PROVIDER_CAPABILITY_TOTAL_FACTS,
  MAX_PROVIDER_CAPABILITY_TOTAL_TEXT_BYTES,
  resolveProviderCapability,
  type ProviderCapabilitySnapshot,
} from "../src/index.js";

const source = "https://provider.example/capabilities";
const now = Date.parse("2026-10-25T00:00:00.000Z");

function snapshot(
  facts: readonly ProviderCapabilitySnapshot["facts"][number][],
  validUntil = "2026-10-26T00:00:00.000Z",
) {
  return createProviderCapabilitySnapshot({
    provider: "cartesia",
    source,
    fetchedAt: "2026-10-24T00:00:00.000Z",
    validUntil,
    facts,
  });
}

describe("provider capability snapshots", () => {
  it("reuses immutable snapshot lists normalized by the same contract", () => {
    const normalized = createProviderCapabilitySnapshots([
      {
        provider: "cartesia",
        source,
        fetchedAt: "2026-10-24T00:00:00.000Z",
        validUntil: "2026-10-26T00:00:00.000Z",
        facts: [],
      },
    ]);

    expect(createProviderCapabilitySnapshots(normalized)).toBe(normalized);
  });

  it("resolves model and voice scoped facts without treating unknown as supported", () => {
    const capabilities = snapshot([
      {
        feature: "tts.pronunciationDictionary",
        scope: "model",
        model: "sonic-3.6",
        status: "supported",
      },
      {
        feature: "tts.speed",
        scope: "voice",
        model: "sonic-3.6",
        voice: "voice-pvc",
        status: "unknown",
      },
    ]);

    expect(
      resolveProviderCapability(
        [capabilities],
        {
          provider: "cartesia",
          feature: "tts.pronunciationDictionary",
          scope: "model",
          model: "sonic-3.6",
        },
        now,
      ),
    ).toMatchObject({ status: "supported", scope: "model", source });
    expect(
      resolveProviderCapability(
        [capabilities],
        {
          provider: "cartesia",
          feature: "tts.speed",
          scope: "voice",
          model: "sonic-3.6",
          voice: "voice-pvc",
        },
        now,
      ),
    ).toMatchObject({ status: "unknown", scope: "voice", reason: "fact_unknown" });
  });

  it("preserves bounded capability values for voice metadata", () => {
    const locales = ["hi-IN", "en-IN"];
    const capabilities = snapshot([
      {
        feature: "tts.voice.accents",
        scope: "voice",
        voice: "voice-1",
        status: "supported",
        value: locales,
      },
    ]);

    locales.push("fr-FR");
    const result = resolveProviderCapability(
      [capabilities],
      {
        provider: "cartesia",
        feature: "tts.voice.accents",
        scope: "voice",
        voice: "voice-1",
      },
      now,
    );

    expect(result).toMatchObject({ status: "supported", value: ["hi-IN", "en-IN"] });
    expect(Object.isFrozen(capabilities.facts[0]?.value)).toBe(true);
    expect(() => {
      if (result.status === "supported" && Array.isArray(result.value)) {
        result.value.push("fr-FR");
      }
    }).toThrow();
  });

  it("rejects unsupported capability value shapes and sizes", () => {
    expect(() =>
      snapshot([
        {
          feature: "tts.voice.accents",
          scope: "voice",
          voice: "voice-1",
          status: "supported",
          value: ["hi-IN", 1],
        } as never,
      ]),
    ).toThrow(/value/);
    expect(() =>
      snapshot([
        {
          feature: "tts.voice.accents",
          scope: "voice",
          voice: "voice-1",
          status: "supported",
          value: Array.from({ length: 65 }, (_, index) => `locale-${index}`),
        },
      ]),
    ).toThrow(/value/);
  });

  it("does not use provider support as proof for a specific voice ID", () => {
    const capabilities = snapshot([
      {
        feature: "tts.customVoice",
        scope: "provider",
        status: "supported",
      },
    ]);

    expect(
      resolveProviderCapability(
        [capabilities],
        {
          provider: "cartesia",
          feature: "tts.customVoice",
          scope: "voice",
          voice: "unverified-voice",
        },
        now,
      ),
    ).toMatchObject({ status: "unknown", reason: "fact_missing" });
  });

  it("returns unknown when the snapshot is absent or expired", () => {
    const capabilities = snapshot(
      [{ feature: "tts.customVoice", scope: "voice", voice: "voice-1", status: "supported" }],
      "2026-10-24T12:00:00.000Z",
    );

    expect(
      resolveProviderCapability(
        [],
        {
          provider: "cartesia",
          feature: "tts.customVoice",
          scope: "voice",
          voice: "voice-1",
        },
        now,
      ),
    ).toMatchObject({ status: "unknown", reason: "snapshot_missing" });
    expect(
      resolveProviderCapability(
        [capabilities],
        {
          provider: "cartesia",
          feature: "tts.customVoice",
          scope: "voice",
          voice: "voice-1",
        },
        now,
      ),
    ).toMatchObject({ status: "unknown", reason: "snapshot_expired" });
  });

  it("returns unknown for future-dated and ambiguous provider snapshots", () => {
    const capabilities = snapshot([
      { feature: "tts.speed", scope: "model", model: "sonic-3.6", status: "supported" },
    ]);
    const future = createProviderCapabilitySnapshot({
      ...capabilities,
      fetchedAt: "2026-10-26T00:00:00.000Z",
      validUntil: "2026-10-27T00:00:00.000Z",
    });
    const query = {
      provider: "cartesia",
      feature: "tts.speed",
      scope: "model" as const,
      model: "sonic-3.6",
    };

    expect(resolveProviderCapability([future], query, now)).toMatchObject({
      status: "unknown",
      reason: "snapshot_not_yet_valid",
    });
    expect(resolveProviderCapability([capabilities, capabilities], query, now)).toMatchObject({
      status: "unknown",
      reason: "snapshot_ambiguous",
    });
  });

  it("freezes a bounded snapshot and rejects conflicting facts", () => {
    const fact = {
      feature: "tts.customVoice",
      scope: "voice" as const,
      voice: "voice-1",
      status: "supported" as const,
    };
    const capabilities = snapshot([fact]);

    expect(Object.isFrozen(capabilities)).toBe(true);
    expect(Object.isFrozen(capabilities.facts)).toBe(true);
    expect(Object.isFrozen(capabilities.facts[0])).toBe(true);
    expect(() => snapshot([fact, fact])).toThrow(/duplicate capability fact/);
    expect(() =>
      createProviderCapabilitySnapshot({
        provider: "cartesia",
        source,
        fetchedAt: "2026-10-24T00:00:00.000Z",
        validUntil: "2026-10-23T00:00:00.000Z",
        facts: [],
      }),
    ).toThrow(/validUntil/);
  });

  it("validates snapshots again at the resolver boundary", () => {
    const capabilities = snapshot([
      { feature: "tts.speed", scope: "model", model: "sonic-3.6", status: "supported" },
    ]);

    expect(() =>
      resolveProviderCapability(
        [{ ...capabilities, source: "http://provider.example/capabilities" }],
        {
          provider: "cartesia",
          feature: "tts.speed",
          scope: "model",
          model: "sonic-3.6",
        },
        now,
      ),
    ).toThrow(/HTTPS/);
  });

  it("rejects malformed facts supplied through an untyped configuration", () => {
    const malformed: unknown = {
      provider: "cartesia",
      source,
      fetchedAt: "2026-10-24T00:00:00.000Z",
      validUntil: "2026-10-26T00:00:00.000Z",
      facts: [null],
    };

    expect(() => createProviderCapabilitySnapshot(malformed)).toThrow(
      "Provider capability fact must be an object",
    );
  });

  it("rejects sparse facts, values, and snapshot lists", () => {
    const sparseFacts = Array(1);
    expect(() =>
      createProviderCapabilitySnapshot({
        provider: "cartesia",
        source,
        fetchedAt: "2026-10-24T00:00:00.000Z",
        validUntil: "2026-10-26T00:00:00.000Z",
        facts: sparseFacts,
      }),
    ).toThrow(/fact must be an object/);

    const sparseLocales: string[] = [];
    sparseLocales.length = 1;
    expect(() =>
      snapshot([
        {
          feature: "tts.voice.verifiedLocales",
          scope: "voice",
          voice: "voice-1",
          status: "supported",
          value: sparseLocales,
        },
      ]),
    ).toThrow(/value/);

    const sparseSnapshots = Array(1) as unknown as ProviderCapabilitySnapshot[];
    expect(() =>
      resolveProviderCapability(
        sparseSnapshots,
        {
          provider: "cartesia",
          feature: "tts.speed",
          scope: "model",
          model: "sonic-3.6",
        },
        now,
      ),
    ).toThrow(/snapshot must be an object/);
  });

  it("bounds the aggregate fact count and text in a snapshot set", () => {
    const facts = Array.from({ length: MAX_PROVIDER_CAPABILITY_FACTS }, (_, index) => ({
      feature: `feature-${index}`,
      scope: "provider" as const,
      status: "supported" as const,
    }));
    const factSet = Array.from({ length: 5 }, (_, index) => ({
      provider: `provider-${index}`,
      source,
      fetchedAt: "2026-10-24T00:00:00.000Z",
      validUntil: "2026-10-26T00:00:00.000Z",
      facts,
    }));

    expect(MAX_PROVIDER_CAPABILITY_TOTAL_FACTS).toBe(2_048);
    expect(() => createProviderCapabilitySnapshots(factSet)).toThrow(/at most 2048 facts/);

    const value = "x".repeat(256);
    const largeFacts = Array.from({ length: MAX_PROVIDER_CAPABILITY_FACTS }, (_, index) => ({
      feature: `feature-${index}`,
      scope: "provider" as const,
      status: "supported" as const,
      value: Array.from({ length: 64 }, () => value),
    }));
    expect(MAX_PROVIDER_CAPABILITY_TOTAL_TEXT_BYTES).toBe(4_194_304);
    expect(() =>
      createProviderCapabilitySnapshots([
        {
          provider: "cartesia",
          source,
          fetchedAt: "2026-10-24T00:00:00.000Z",
          validUntil: "2026-10-26T00:00:00.000Z",
          facts: largeFacts,
        },
      ]),
    ).toThrow(/bytes of text/);
  });

  it.each(["2026-02-30T00:00:00.000Z", "2025-02-29T00:00:00.000Z"])(
    "rejects impossible calendar dates in snapshot timestamps: %s",
    (timestamp) => {
      expect(() =>
        createProviderCapabilitySnapshot({
          provider: "cartesia",
          source,
          fetchedAt: timestamp,
          validUntil: "2026-10-26T00:00:00.000Z",
          facts: [],
        }),
      ).toThrow(/UTC timestamp/);
      expect(() =>
        createProviderCapabilitySnapshot({
          provider: "cartesia",
          source,
          fetchedAt: "2025-01-01T00:00:00.000Z",
          validUntil: timestamp,
          facts: [],
        }),
      ).toThrow(/UTC timestamp/);
    },
  );
});
