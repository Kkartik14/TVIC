import WebSocket from "ws";
import { describe, expect, it } from "vitest";

import { PCM16_16K_MONO } from "@tvic/core";

import { ElevenLabsSttProvider } from "../src/index.js";
import { PROVIDER_CATALOG } from "../src/catalog.js";

const batchModels = ["scribe_v2", "scribe_v2_medical"] as const;

describe("ElevenLabs Scribe model transports", () => {
  it.each(PROVIDER_CATALOG.elevenlabsStt.models)(
    "catalogs and validates %s without silently selecting another model",
    async (model) => {
      const provider = new ElevenLabsSttProvider({
        apiKey: "test",
        modelId: model,
        webSocketFactory: () => new FakeSocket() as never,
      });
      expect(provider.capabilities.transports).toEqual(["http", "websocket"]);

      if (batchModels.includes(model as (typeof batchModels)[number])) {
        await expect(
          provider.open({
            sessionId: "batch-model-session" as never,
            format: PCM16_16K_MONO,
            interimResults: true,
          }),
        ).rejects.toMatchObject({
          code: "provider.invalid_request",
          metadata: { model },
        });
      } else {
        await expect(
          provider.open({
            sessionId: "realtime-model-session" as never,
            format: PCM16_16K_MONO,
            interimResults: true,
          }),
        ).resolves.toBeDefined();
      }
    },
  );

  it.each(batchModels)("sends %s through the batch transcription API", async (model) => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    const provider = new ElevenLabsSttProvider({
      apiKey: "eleven-key",
      modelId: model,
      batchUrl: "https://example.test/v1/speech-to-text",
      fetchImpl: async (input, init) => {
        requestUrl = String(input);
        requestInit = init;
        return new Response(
          JSON.stringify({
            language_code: "en",
            language_probability: 0.98,
            text: "Hello from Scribe",
            words: [{ text: "Hello", start: 0, end: 0.4, type: "word", speaker_id: "speaker_1" }],
            entities: [{ text: "Scribe", type: "product", start: 11, end: 17 }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    const result = await provider.transcribe({
      audio: new Uint8Array(3_200),
      format: PCM16_16K_MONO,
      keyterms: ["TVIC", "Scribe"],
      tagAudioEvents: true,
      diarize: true,
      numSpeakers: 2,
      timestampsGranularity: "word",
      entityDetection: ["pii", "medical"],
      noVerbatim: true,
      model,
    });

    expect(requestUrl).toBe("https://example.test/v1/speech-to-text");
    expect(requestInit?.method).toBe("POST");
    expect(requestInit?.headers).toEqual({ "xi-api-key": "eleven-key" });
    const form = requestInit?.body as FormData;
    expect(form.get("model_id")).toBe(model);
    expect(form.get("file_format")).toBe("pcm_s16le_16");
    expect(form.getAll("keyterms")).toEqual(["TVIC", "Scribe"]);
    expect(form.getAll("entity_detection")).toEqual(["pii", "medical"]);
    expect(form.get("no_verbatim")).toBe("true");
    expect(result).toMatchObject({
      modelId: model,
      text: "Hello from Scribe",
      languageCode: "en",
      languageProbability: 0.98,
    });
    expect(result.words).toHaveLength(1);
    expect(result.entities).toEqual([{ text: "Scribe", type: "product", start: 11, end: 17 }]);
  });

  it("rejects batch-only options that the API cannot honor on the wrong model", async () => {
    const provider = new ElevenLabsSttProvider({
      apiKey: "test",
      fetchImpl: async () => new Response("{}", { status: 200 }),
    });

    await expect(
      provider.transcribe({
        audio: new Uint8Array(3_200),
        format: PCM16_16K_MONO,
        model: "scribe_v2_realtime",
      }),
    ).rejects.toMatchObject({
      code: "provider.invalid_request",
      metadata: { model: "scribe_v2_realtime", transport: "websocket" },
    });
  });

  it("rejects malformed batch responses instead of returning unbounded provider data", async () => {
    const provider = new ElevenLabsSttProvider({
      apiKey: "test",
      fetchImpl: async () =>
        new Response(JSON.stringify({ text: "ok", words: [{ start: "bad" }] }), { status: 200 }),
    });

    await expect(
      provider.transcribe({
        audio: new Uint8Array(3_200),
        format: PCM16_16K_MONO,
        model: "scribe_v2",
      }),
    ).rejects.toMatchObject({
      code: "provider.protocol_invalid",
      provider: "elevenlabs-stt-realtime",
    });
  });

  it("rejects an oversized batch response before parsing it", async () => {
    const provider = new ElevenLabsSttProvider({
      apiKey: "test",
      fetchImpl: async () => new Response("x".repeat(4 * 1024 * 1024 + 1), { status: 200 }),
    });

    await expect(
      provider.transcribe({
        audio: new Uint8Array(3_200),
        format: PCM16_16K_MONO,
        model: "scribe_v2",
      }),
    ).rejects.toMatchObject({
      code: "provider.protocol_invalid",
      provider: "elevenlabs-stt-realtime",
    });
  });

  it("rejects malformed batch entity values instead of silently dropping them", async () => {
    const provider = new ElevenLabsSttProvider({
      apiKey: "test",
      fetchImpl: async () =>
        new Response(JSON.stringify({ text: "ok", entities: [{ type: { nested: true } }] }), {
          status: 200,
        }),
    });

    await expect(
      provider.transcribe({
        audio: new Uint8Array(3_200),
        format: PCM16_16K_MONO,
        model: "scribe_v2",
      }),
    ).rejects.toMatchObject({
      code: "provider.protocol_invalid",
      provider: "elevenlabs-stt-realtime",
    });
  });

  it("rejects provider-invalid batch combinations before fetch", async () => {
    let fetchCalls = 0;
    const provider = new ElevenLabsSttProvider({
      apiKey: "test",
      fetchImpl: async () => {
        fetchCalls += 1;
        return new Response("{}", { status: 200 });
      },
    });

    await expect(
      provider.transcribe({
        audio: new Uint8Array(3_200),
        format: PCM16_16K_MONO,
        model: "scribe_v2_medical",
        diarize: true,
        numSpeakers: 2,
        diarizationThreshold: 0.2,
      }),
    ).rejects.toMatchObject({ code: "provider.invalid_request" });
    expect(fetchCalls).toBe(0);
  });

  it("rejects malformed batch option types before fetch", async () => {
    let fetchCalls = 0;
    const provider = new ElevenLabsSttProvider({
      apiKey: "test",
      fetchImpl: async () => {
        fetchCalls += 1;
        return new Response("{}", { status: 200 });
      },
    });

    await expect(
      provider.transcribe({
        audio: new Uint8Array(3_200),
        format: PCM16_16K_MONO,
        model: "scribe_v2",
        noVerbatim: "true",
      } as never),
    ).rejects.toMatchObject({ code: "provider.invalid_request" });
    expect(fetchCalls).toBe(0);
  });

  it.each([
    [401, "provider.auth_failed", false],
    [402, "provider.rate_limited", true],
    [403, "provider.auth_failed", false],
    [429, "provider.rate_limited", true],
    [503, "provider.upstream_failed", true],
  ])("maps batch HTTP %s without reporting success", async (status, code, retriable) => {
    const provider = new ElevenLabsSttProvider({
      apiKey: "test",
      fetchImpl: async () =>
        new Response(JSON.stringify({ detail: "provider failure" }), { status }),
    });

    await expect(
      provider.transcribe({
        audio: new Uint8Array(3_200),
        format: PCM16_16K_MONO,
        model: "scribe_v2",
      }),
    ).rejects.toMatchObject({ code, retriable });
  });
});

class FakeSocket {
  readyState: number = WebSocket.OPEN;

  on(_event: string, _handler: (...values: unknown[]) => void): this {
    return this;
  }

  send(_data: string | Buffer): void {}

  close(): void {
    this.readyState = WebSocket.CLOSED;
  }
}
