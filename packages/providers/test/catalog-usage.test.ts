import { describe, expect, it } from "vitest";

import { PROVIDER_CATALOG } from "../src/catalog.js";

type UsageMetricDeclaration = {
  readonly status: "provider_reported" | "runtime_measured" | "not_reported";
  readonly unit?: string;
  readonly source: string;
  readonly verifiedAt: string;
  readonly providerField?: string;
  readonly originalUnit?: string;
  readonly reason?: "not_documented" | "unverified";
  readonly note: string;
};

type UsageRoute = {
  readonly scope: "live" | "batch" | "sync";
  readonly transport: string;
  readonly metrics: Readonly<Record<string, UsageMetricDeclaration>>;
};

type CatalogEntryWithUsage = {
  readonly usage?: { readonly routes?: Readonly<Record<string, UsageRoute>> };
};

const catalog = PROVIDER_CATALOG as unknown as Readonly<Record<string, CatalogEntryWithUsage>>;

function routesFor(provider: keyof typeof PROVIDER_CATALOG): Readonly<Record<string, UsageRoute>> {
  const routes = catalog[provider]?.usage?.routes;
  expect(routes, `${provider} should declare route-level usage evidence`).toBeDefined();
  return routes ?? {};
}

describe("provider catalog usage evidence", () => {
  it("declares every implemented adapter route without merging batch or sync paths into live routes", () => {
    const expectedRoutes: Readonly<Record<keyof typeof PROVIDER_CATALOG, readonly string[]>> = {
      deepgram: ["realtime"],
      cartesiaStt: ["realtimeManual", "realtimeAuto", "batch"],
      sarvam: ["realtime"],
      sarvamTts: ["websocket", "rest", "httpStream"],
      cartesia: ["websocket"],
      elevenlabs: [
        "websocket",
        "multiContextWebsocket",
        "httpConvert",
        "httpStream",
        "dialogueWebsocket",
        "dialogueMultiContextWebsocket",
        "dialogueHttpConvert",
        "dialogueHttpStream",
      ],
      elevenlabsStt: ["realtime", "batch"],
      assemblyai: ["realtime", "preRecorded", "sync"],
      soniox: ["realtime"],
      groq: ["streaming"],
      openaiResponses: ["streaming"],
    };

    for (const [provider, expected] of Object.entries(expectedRoutes)) {
      expect(Object.keys(routesFor(provider as keyof typeof PROVIDER_CATALOG)).sort()).toEqual(
        [...expected].sort(),
      );
    }
  });

  it("declares dated usage evidence for every LLM, STT, and TTS catalog entry", () => {
    for (const [provider, entry] of Object.entries(catalog)) {
      const routes = entry.usage?.routes;
      expect(routes, `${provider} is missing usage routes`).toBeDefined();
      expect(Object.keys(routes ?? {}).length, `${provider} has no usage routes`).toBeGreaterThan(
        0,
      );

      for (const [routeName, route] of Object.entries(routes ?? {})) {
        expect(["live", "batch", "sync"], `${provider}.${routeName} has a route scope`).toContain(
          route.scope,
        );
        expect(route.transport, `${provider}.${routeName} has a transport`).toBeTruthy();
        expect(
          Object.keys(route.metrics).length,
          `${provider}.${routeName} has metric evidence`,
        ).toBeGreaterThan(0);

        for (const [metricName, metric] of Object.entries(route.metrics)) {
          expect(
            ["provider_reported", "runtime_measured", "not_reported"],
            `${provider}.${routeName}.${metricName} has a supported status`,
          ).toContain(metric.status);
          expect(
            metric.source,
            `${provider}.${routeName}.${metricName} has provenance`,
          ).toBeTruthy();
          expect(
            metric.verifiedAt,
            `${provider}.${routeName}.${metricName} has its own verification date`,
          ).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
          expect(
            metric.note,
            `${provider}.${routeName}.${metricName} explains its meaning`,
          ).toBeTruthy();
          if (metric.status === "provider_reported") {
            expect(
              metric.providerField,
              `${provider}.${routeName}.${metricName} names the wire field`,
            ).toBeTruthy();
            expect(
              metric.unit,
              `${provider}.${routeName}.${metricName} declares its unit`,
            ).toBeTruthy();
          }
          if (metric.status === "not_reported") {
            expect(
              ["not_documented", "unverified"],
              `${provider}.${routeName}.${metricName} explains missing evidence`,
            ).toContain(metric.reason);
          }
        }
      }
    }
  });

  it("keeps all live-session runtime measures distinct from provider reports", () => {
    for (const provider of [
      "deepgram",
      "cartesiaStt",
      "sarvam",
      "elevenlabsStt",
      "assemblyai",
      "soniox",
    ] as const) {
      for (const [routeName, route] of Object.entries(routesFor(provider))) {
        if (route.scope !== "live") continue;
        expect(
          route.metrics.audioMsSent,
          `${provider}.${routeName} records runtime STT audio`,
        ).toMatchObject({
          status: "runtime_measured",
          unit: "milliseconds",
        });
      }
    }

    for (const provider of ["cartesia", "elevenlabs", "sarvamTts"] as const) {
      for (const [routeName, route] of Object.entries(routesFor(provider))) {
        if (route.scope !== "live") continue;
        expect(
          route.metrics.charactersSent,
          `${provider}.${routeName} records runtime TTS text`,
        ).toMatchObject({
          status: "runtime_measured",
          unit: "unicode_code_points",
        });
        expect(
          route.metrics.audioMsReceived,
          `${provider}.${routeName} records runtime PCM`,
        ).toMatchObject({
          status: "runtime_measured",
          unit: "milliseconds",
        });
      }
    }

    for (const provider of ["groq", "openaiResponses"] as const) {
      for (const [routeName, route] of Object.entries(routesFor(provider))) {
        if (route.scope !== "live") continue;
        expect(
          route.metrics.requestCount,
          `${provider}.${routeName} counts runtime requests`,
        ).toMatchObject({
          status: "runtime_measured",
          unit: "requests",
        });
      }
    }
  });

  it("keeps realtime, batch, and sync STT usage on separate route declarations", () => {
    const cartesia = routesFor("cartesiaStt");
    expect(cartesia).toMatchObject({
      realtimeManual: { scope: "live" },
      realtimeAuto: { scope: "live" },
      batch: { scope: "batch" },
    });
    expect(cartesia.realtimeManual?.metrics.providerAudioMs).toMatchObject({
      status: "provider_reported",
      providerField: "duration",
      originalUnit: "seconds",
    });
    expect(cartesia.realtimeAuto?.metrics.providerAudioMs).toMatchObject({
      status: "not_reported",
      reason: "unverified",
    });
    expect(cartesia.batch?.metrics.providerAudioMs).toMatchObject({
      status: "not_reported",
      reason: "unverified",
    });

    const assemblyAi = routesFor("assemblyai");
    expect(assemblyAi).toMatchObject({
      realtime: { scope: "live" },
      preRecorded: { scope: "batch" },
      sync: { scope: "sync" },
    });
    expect(assemblyAi.realtime?.metrics.providerAudioMs).toMatchObject({
      providerField: "Termination.audio_duration_seconds",
      originalUnit: "seconds",
    });
    expect(assemblyAi.realtime?.metrics.providerSessionMs).toMatchObject({
      providerField: "Termination.session_duration_seconds",
      originalUnit: "seconds",
    });
    expect(assemblyAi.preRecorded?.metrics.providerAudioMs).toMatchObject({
      providerField: "audio_duration",
      originalUnit: "seconds",
    });
    expect(assemblyAi.sync?.metrics.providerAudioMs).toMatchObject({
      providerField: "audio_duration_ms",
      originalUnit: "milliseconds",
    });
    expect(assemblyAi.preRecorded?.metrics.audioMsSent).toBeUndefined();
    expect(assemblyAi.sync?.metrics.audioMsSent).toBeUndefined();
  });

  it("documents only route-specific provider usage for LLM and TTS", () => {
    const groq = routesFor("groq").streaming;
    expect(groq?.metrics).toMatchObject({
      inputTokens: {
        status: "provider_reported",
        providerField: "usage.prompt_tokens (or usage.input_tokens)",
      },
      outputTokens: {
        status: "provider_reported",
        providerField: "usage.completion_tokens (or usage.output_tokens)",
      },
      cachedTokens: {
        status: "provider_reported",
        providerField:
          "usage.prompt_tokens_details.cached_tokens (or usage.input_tokens_details.cached_tokens)",
      },
    });
    expect(groq?.metrics.inputTokens?.note).toMatch(
      /cached tokens.*included within this input count/iu,
    );

    const openAi = routesFor("openaiResponses").streaming;
    expect(openAi?.metrics).toMatchObject({
      inputTokens: { status: "provider_reported", providerField: "response.usage.input_tokens" },
      outputTokens: { status: "provider_reported", providerField: "response.usage.output_tokens" },
      cachedTokens: {
        status: "provider_reported",
        providerField: "response.usage.input_tokens_details.cached_tokens",
      },
    });

    const elevenLabs = routesFor("elevenlabs");
    expect(elevenLabs.httpConvert?.metrics.providerCharacterCount).toMatchObject({
      status: "provider_reported",
      providerField: "character-cost",
    });
    for (const routeName of [
      "httpStream",
      "websocket",
      "multiContextWebsocket",
      "dialogueHttpConvert",
      "dialogueHttpStream",
      "dialogueWebsocket",
      "dialogueMultiContextWebsocket",
    ]) {
      expect(
        elevenLabs[routeName]?.metrics.providerCharacterCount,
        `${routeName} must not inherit standard Convert headers`,
      ).toMatchObject({
        status: "not_reported",
      });
    }
  });

  it("preserves distinct live STT provider duration meanings and non-additive observations", () => {
    expect(routesFor("deepgram").realtime?.metrics.providerAudioMs).toMatchObject({
      providerField: "Metadata.duration",
      originalUnit: "seconds",
      note: expect.stringMatching(/stream-level/u),
    });
    expect(routesFor("sarvam").realtime?.metrics.providerAudioDuration).toMatchObject({
      providerField: "data.metrics.audio_duration",
      unit: "provider_defined",
      note: expect.stringMatching(/observation/u),
    });
    expect(routesFor("sarvam").realtime?.metrics.providerProcessingDuration).toMatchObject({
      providerField: "data.metrics.processing_latency",
      unit: "provider_defined",
    });
    expect(routesFor("soniox").realtime?.metrics.providerFinalAudioProcessedMs).toMatchObject({
      providerField: "final_audio_proc_ms",
      originalUnit: "milliseconds",
    });
    expect(routesFor("soniox").realtime?.metrics.providerTotalAudioProcessedMs).toMatchObject({
      providerField: "total_audio_proc_ms",
      originalUnit: "milliseconds",
    });
    expect(routesFor("elevenlabsStt").realtime?.metrics.providerAudioMs).toMatchObject({
      status: "not_reported",
      reason: "not_documented",
    });
    expect(routesFor("elevenlabsStt").batch?.metrics.providerAudioMs).toMatchObject({
      status: "not_reported",
      reason: "not_documented",
    });
  });
});
