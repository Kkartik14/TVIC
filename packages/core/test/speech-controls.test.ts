import { describe, expect, it } from "vitest";

import {
  createSpeechControlCatalogSnapshot,
  hasSpeechControlCatalogFact,
  querySpeechControlCatalog,
  type SpeechControlFact,
} from "../src/index.js";

const facts: readonly SpeechControlFact[] = [
  {
    provider: "test-tts",
    control: "tts.pause",
    scope: { type: "model", model: "model-a" },
    status: "supported",
    mutability: "call",
    source: "https://provider.example/docs/tts",
    verifiedAt: "2026-10-20",
  },
  {
    provider: "test-tts",
    control: "tts.pause",
    scope: { type: "model", model: "model-b" },
    status: "unsupported",
    mutability: "call",
    source: "https://provider.example/docs/tts",
    verifiedAt: "2026-10-20",
  },
  {
    provider: "test-tts",
    control: "tts.voice",
    scope: { type: "account", model: "model-a", voice: "account-voice" },
    status: "supported",
    mutability: "provider",
    source: "https://provider.example/api/voices",
    verifiedAt: "2026-10-20",
  },
];

describe("speech control catalog snapshots", () => {
  it("uses the most specific provider/model/voice/account fact", () => {
    const snapshot = createSpeechControlCatalogSnapshot(facts, {
      fetchedAt: "2026-10-20T00:00:00.000Z",
      validUntil: "2026-10-21T00:00:00.000Z",
    });

    expect(
      querySpeechControlCatalog(
        snapshot,
        {
          provider: "test-tts",
          control: "tts.pause",
          model: "model-a",
        },
        "2026-10-20T12:00:00.000Z",
      ),
    ).toMatchObject({
      status: "supported",
      fact: { scope: { type: "model", model: "model-a" } },
    });
    expect(
      querySpeechControlCatalog(
        snapshot,
        {
          provider: "test-tts",
          control: "tts.voice",
          model: "model-a",
          voice: "account-voice",
        },
        "2026-10-20T12:00:00.000Z",
      ),
    ).toMatchObject({ status: "supported", fact: { scope: { type: "account" } } });
  });

  it("distinguishes an unknown fact from an explicitly unsupported fact", () => {
    const snapshot = createSpeechControlCatalogSnapshot(facts, {
      fetchedAt: "2026-10-20T00:00:00.000Z",
      validUntil: "2026-10-21T00:00:00.000Z",
    });

    expect(
      querySpeechControlCatalog(
        snapshot,
        {
          provider: "test-tts",
          control: "tts.pause",
          model: "model-b",
        },
        "2026-10-20T12:00:00.000Z",
      ).status,
    ).toBe("unsupported");
    expect(
      querySpeechControlCatalog(
        snapshot,
        {
          provider: "test-tts",
          control: "tts.pause",
          model: "unlisted-model",
        },
        "2026-10-20T12:00:00.000Z",
      ).status,
    ).toBe("unknown");
    expect(
      querySpeechControlCatalog(
        snapshot,
        {
          provider: "test-tts",
          control: "tts.voice",
          model: "model-a",
          voice: "unlisted-voice",
        },
        "2026-10-20T12:00:00.000Z",
      ).status,
    ).toBe("unknown");
  });

  it("marks the complete snapshot expired instead of returning stale support", () => {
    const snapshot = createSpeechControlCatalogSnapshot(facts, {
      fetchedAt: "2026-10-20T00:00:00.000Z",
      validUntil: "2026-10-21T00:00:00.000Z",
    });

    expect(
      querySpeechControlCatalog(
        snapshot,
        { provider: "test-tts", control: "tts.pause", model: "model-a" },
        "2026-10-22T00:00:00.000Z",
      ).status,
    ).toBe("expired");
  });

  it("does not use account facts before their snapshot fetch time", () => {
    const snapshot = createSpeechControlCatalogSnapshot(facts, {
      fetchedAt: "2026-10-20T12:00:00.000Z",
      validUntil: "2026-10-21T00:00:00.000Z",
    });

    expect(
      querySpeechControlCatalog(
        snapshot,
        { provider: "test-tts", control: "tts.pause", model: "model-a" },
        "2026-10-20T11:59:59.999Z",
      ).status,
    ).toBe("not_yet_valid");
  });

  it("matches account voice availability independently of model", () => {
    const snapshot = createSpeechControlCatalogSnapshot(
      [
        {
          provider: "test-tts",
          control: "tts.voice",
          scope: { type: "account", voice: "account-voice" },
          status: "supported",
          mutability: "provider",
          source: "https://provider.example/api/voices",
          verifiedAt: "2026-10-20",
        },
      ],
      {
        fetchedAt: "2026-10-20T00:00:00.000Z",
        validUntil: "2026-10-21T00:00:00.000Z",
      },
    );

    expect(
      querySpeechControlCatalog(
        snapshot,
        {
          provider: "test-tts",
          control: "tts.voice",
          model: "model-a",
          voice: "account-voice",
        },
        "2026-10-20T12:00:00.000Z",
      ),
    ).toMatchObject({
      status: "supported",
      fact: { scope: { type: "account", voice: "account-voice" } },
    });
  });

  it("reports whether a snapshot owns a provider control", () => {
    const snapshot = createSpeechControlCatalogSnapshot(facts, {
      fetchedAt: "2026-10-20T00:00:00.000Z",
      validUntil: "2026-10-21T00:00:00.000Z",
    });

    expect(hasSpeechControlCatalogFact(snapshot, "test-tts", "tts.pause")).toBe(true);
    expect(hasSpeechControlCatalogFact(snapshot, "test-tts", "tts.model")).toBe(false);
  });

  it("copies and freezes caller-owned facts and rejects ambiguous duplicates", () => {
    const mutableFacts = facts.map((fact) => ({
      ...fact,
      scope: { ...fact.scope },
    })) as SpeechControlFact[];
    const snapshot = createSpeechControlCatalogSnapshot(mutableFacts, {
      fetchedAt: "2026-10-20T00:00:00.000Z",
      validUntil: "2026-10-21T00:00:00.000Z",
    });

    mutableFacts.pop();
    expect(snapshot.facts).toHaveLength(3);
    expect(Object.isFrozen(snapshot.facts)).toBe(true);
    expect(Object.isFrozen(snapshot.facts[0]?.scope)).toBe(true);

    expect(() =>
      createSpeechControlCatalogSnapshot([facts[0]!, facts[0]!], {
        fetchedAt: "2026-10-20T00:00:00.000Z",
        validUntil: "2026-10-21T00:00:00.000Z",
      }),
    ).toThrow(/duplicate/i);
  });

  it("copies and freezes nested language lists and numeric limits", () => {
    const mutableLanguages = ["en-US"];
    const snapshot = createSpeechControlCatalogSnapshot(
      [
        {
          provider: "test-tts",
          control: "tts.language",
          scope: { type: "model", model: "model-a" },
          status: "supported",
          mutability: "call",
          source: "https://provider.example/docs/tts",
          verifiedAt: "2026-10-20",
          languages: mutableLanguages,
          limits: { maxCharacters: 2_000 },
        },
      ],
      {
        fetchedAt: "2026-10-20T00:00:00.000Z",
        validUntil: "2026-10-21T00:00:00.000Z",
      },
    );

    mutableLanguages.push("hi-IN");
    const fact = snapshot.facts[0]!;
    expect(fact.languages).toEqual(["en-US"]);
    expect(Object.isFrozen(fact.languages)).toBe(true);
    expect(Object.isFrozen(fact.limits)).toBe(true);
  });

  it("rejects impossible calendar dates and credential-bearing source URLs", () => {
    expect(() =>
      createSpeechControlCatalogSnapshot(
        [
          {
            ...facts[0]!,
            verifiedAt: "2026-02-31",
          },
        ],
        {
          fetchedAt: "2026-10-20T00:00:00.000Z",
          validUntil: "2026-10-21T00:00:00.000Z",
        },
      ),
    ).toThrow(/verifiedAt/u);

    expect(() =>
      createSpeechControlCatalogSnapshot(
        [
          {
            ...facts[0]!,
            source: "https://user:secret@provider.example/docs/tts",
          },
        ],
        {
          fetchedAt: "2026-10-20T00:00:00.000Z",
          validUntil: "2026-10-21T00:00:00.000Z",
        },
      ),
    ).toThrow(/HTTPS URL/u);
  });
});
