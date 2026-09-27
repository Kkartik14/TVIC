import { describe, expect, it } from "vitest";

import { PCM16_16K_MONO, PROVIDER_NAMES, type AudioFormat } from "@tvic/core";

import {
  ASSEMBLYAI_PRE_RECORDED_MODELS,
  ASSEMBLYAI_REALTIME_MODELS,
  ASSEMBLYAI_SYNC_MODELS,
  AssemblyAiSttProvider,
} from "../src/index.js";

const SYNC_FORMAT: AudioFormat = PCM16_16K_MONO;
const SYNC_AUDIO = new Uint8Array(3_200);

describe("AssemblyAI HTTP STT surfaces", () => {
  it("uploads local audio, submits a pre-recorded job, polls, and normalizes the result", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    let polls = 0;
    const provider = new AssemblyAiSttProvider({
      apiKey: "assembly-key",
      preRecordedUrl: "https://example.test/v2/transcript",
      uploadUrl: "https://example.test/v2/upload",
      fetchImpl: async (input, init = {}) => {
        const url = String(input);
        calls.push({ url, init });
        if (url.endsWith("/v2/upload")) {
          expect(init.method).toBe("POST");
          expect(init.headers).toMatchObject({
            Authorization: "assembly-key",
            "Content-Type": "audio/wav",
          });
          expect(Buffer.from(init.body as Uint8Array)).toHaveLength(3_200);
          return new Response(JSON.stringify({ upload_url: "https://example.test/uploaded.wav" }), {
            status: 200,
          });
        }
        if (init.method === "POST") {
          expect(init.headers).toMatchObject({
            Authorization: "assembly-key",
            "Content-Type": "application/json",
          });
          expect(JSON.parse(String(init.body))).toEqual({
            audio_url: "https://example.test/uploaded.wav",
            speech_models: [...ASSEMBLYAI_PRE_RECORDED_MODELS],
            language_detection: true,
            keyterms_prompt: ["TVIC"],
            speaker_labels: true,
            speaker_options: {
              min_speakers_expected: 1,
              max_speakers_expected: 2,
              include_speaker_confidence: true,
            },
          });
          return new Response(JSON.stringify({ id: "transcript_1", status: "queued" }), {
            status: 200,
          });
        }
        polls += 1;
        if (polls === 1) {
          return new Response(JSON.stringify({ id: "transcript_1", status: "processing" }), {
            status: 200,
          });
        }
        return new Response(
          JSON.stringify({
            id: "transcript_1",
            status: "completed",
            speech_model_used: "universal-3-5-pro",
            text: "Hello from AssemblyAI.",
            language_code: "en",
            audio_duration: 2.5,
            confidence: 0.97,
            words: [{ text: "Hello", start: 0, end: 500, confidence: 0.99, speaker: "A" }],
            utterances: [
              {
                text: "Hello from AssemblyAI.",
                start: 0,
                end: 2_500,
                speaker: "A",
                words: [{ text: "Hello", start: 0, end: 500 }],
              },
            ],
          }),
          { status: 200 },
        );
      },
    });

    const result = await provider.transcribe({
      audio: new Uint8Array(3_200),
      mimeType: "audio/wav",
      languageDetection: true,
      vocabulary: ["TVIC"],
      speakerLabels: true,
      speakerOptions: {
        minSpeakersExpected: 1,
        maxSpeakersExpected: 2,
        includeSpeakerConfidence: true,
      },
      pollIntervalMs: 50,
      pollTimeoutMs: 2_000,
    });

    expect(calls.map(({ url }) => url)).toEqual([
      "https://example.test/v2/upload",
      "https://example.test/v2/transcript",
      "https://example.test/v2/transcript/transcript_1",
      "https://example.test/v2/transcript/transcript_1",
    ]);
    expect(result).toMatchObject({
      id: "transcript_1",
      status: "completed",
      modelId: "universal-3-5-pro",
      text: "Hello from AssemblyAI.",
      languageCode: "en",
      audioDurationMs: 2_500,
      confidence: 0.97,
    });
    expect(result.words).toHaveLength(1);
    expect(result.utterances[0]?.words).toHaveLength(1);
  });

  it("uses a supplied URL without uploading and pins one pre-recorded model", async () => {
    const requests: RequestInit[] = [];
    const provider = new AssemblyAiSttProvider({
      apiKey: "assembly-key",
      preRecordedUrl: "https://example.test/v2/transcript",
      uploadUrl: "https://example.test/v2/upload",
      fetchImpl: async (_input, init = {}) => {
        requests.push(init);
        if (init.method === "POST") {
          expect(JSON.parse(String(init.body))).toMatchObject({
            audio_url: "https://cdn.example.test/call.wav",
            speech_models: ["universal-2"],
            punctuate: true,
            format_text: true,
          });
          return new Response(
            JSON.stringify({ id: "transcript_2", status: "completed", text: "done" }),
            {
              status: 200,
            },
          );
        }
        throw new Error("unexpected polling request");
      },
    });

    const result = await provider.transcribe({
      audioUrl: "https://cdn.example.test/call.wav",
      model: "universal-2",
      punctuate: true,
      formatText: true,
    });

    expect(requests).toHaveLength(1);
    expect(result.modelId).toBe("universal-2");
    expect(result.text).toBe("done");
  });

  it("maps current multichannel and PII-redaction options", async () => {
    const provider = new AssemblyAiSttProvider({
      apiKey: "assembly-key",
      preRecordedUrl: "https://example.test/v2/transcript",
      fetchImpl: async (_input, init = {}) => {
        if (init.method === "POST") {
          expect(JSON.parse(String(init.body))).toMatchObject({
            multichannel: true,
            redact_pii: true,
            redact_pii_policies: ["person_name", "phone_number"],
            redact_pii_sub: "entity_name",
            redact_pii_audio: true,
            redact_pii_audio_quality: "wav",
            redact_pii_audio_options: {
              override_audio_redaction_method: "silence",
              return_redacted_no_speech_audio: true,
            },
            redact_pii_return_unredacted: true,
            redact_static_entities: { PROJECT: ["TVIC"] },
          });
          return new Response(
            JSON.stringify({
              id: "transcript-redaction",
              status: "completed",
              text: "[PERSON] called.",
              audio_channels: 2,
            }),
            { status: 200 },
          );
        }
        throw new Error("unexpected polling request");
      },
    });

    const result = await provider.transcribe({
      audioUrl: "https://cdn.example.test/stereo.wav",
      model: "universal-2",
      multichannel: true,
      redactPii: true,
      redactPiiPolicies: ["person_name", "phone_number"],
      redactPiiSub: "entity_name",
      redactPiiAudio: true,
      redactPiiAudioQuality: "wav",
      redactPiiAudioOptions: {
        overrideAudioRedactionMethod: "silence",
        returnRedactedNoSpeechAudio: true,
      },
      redactPiiReturnUnredacted: true,
      redactStaticEntities: { PROJECT: ["TVIC"] },
    });

    expect(result.audioChannels).toBe(2);
  });

  it("rejects transport-specific model mistakes and conflicting sources before HTTP", async () => {
    let calls = 0;
    const provider = new AssemblyAiSttProvider({
      apiKey: "assembly-key",
      fetchImpl: async () => {
        calls += 1;
        return new Response("{}", { status: 200 });
      },
    });

    await expect(
      provider.transcribe({
        audioUrl: "https://example.test/audio.wav",
        model: "universal-3-6-pro",
      }),
    ).rejects.toMatchObject({
      code: "provider.model_unsupported",
      provider: PROVIDER_NAMES.assemblyaiStt,
    });
    await expect(
      provider.transcribe({
        audio: new Uint8Array([1]),
        audioUrl: "https://example.test/audio.wav",
      }),
    ).rejects.toMatchObject({ code: "provider.invalid_request" });
    await expect(
      provider.transcribe({
        audioUrl: "https://example.test/audio.wav",
        redactPii: true,
      }),
    ).rejects.toMatchObject({ code: "provider.invalid_request" });
    await expect(
      provider.transcribe({
        audioUrl: "https://example.test/audio.wav",
        multichannel: true,
        dualChannel: false,
      }),
    ).rejects.toMatchObject({ code: "provider.invalid_request" });
    expect(calls).toBe(0);
  });

  it("sends Sync multipart audio/config, supports warm-up, and normalizes the response", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const provider = new AssemblyAiSttProvider({
      apiKey: "assembly-key",
      syncUrl: "https://sync.example.test/v1/transcribe",
      fetchImpl: async (input, init = {}) => {
        requests.push({ url: String(input), init });
        if (String(input).endsWith("/warm")) return new Response(null, { status: 204 });
        const form = init.body as FormData;
        expect(form.get("audio")).toBeInstanceOf(Blob);
        const config = JSON.parse(await (form.get("config") as Blob).text());
        expect(config).toEqual({
          sample_rate: 16_000,
          channels: 1,
          language_codes: ["en"],
          prompt: "A support call.",
          keyterms_prompt: ["TVIC"],
          timestamps: true,
        });
        expect(init.headers).toEqual({
          Authorization: "assembly-key",
          "X-AAI-Model": "universal-3-5-pro",
        });
        return new Response(
          JSON.stringify({
            text: "Hello from Sync.",
            session_id: "sync-session-1",
            confidence: 0.91,
            audio_duration_ms: 200,
            request_time_ms: 123.4,
            words: [{ text: "Hello", confidence: 0.9, start: 0, end: 200 }],
          }),
          { status: 200 },
        );
      },
    });

    await provider.warmSync();
    const result = await provider.transcribeSync({
      audio: SYNC_AUDIO,
      format: SYNC_FORMAT,
      languageCodes: ["en"],
      prompt: "A support call.",
      vocabulary: ["TVIC"],
      timestamps: true,
    });

    expect(requests[0]?.url).toBe("https://sync.example.test/v1/warm");
    expect(requests[1]?.url).toBe("https://sync.example.test/v1/transcribe");
    expect(result).toMatchObject({
      sessionId: "sync-session-1",
      modelId: "universal-3-5-pro",
      text: "Hello from Sync.",
      confidence: 0.91,
      audioDurationMs: 200,
      requestTimeMs: 123.4,
    });
  });

  it("streams Sync live multipart audio with config first and normalizes the response", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const provider = new AssemblyAiSttProvider({
      apiKey: "assembly-key",
      syncUrl: "https://sync.example.test/v1/transcribe",
      fetchImpl: async (input, init = {}) => {
        requests.push({ url: String(input), init });
        expect(init.method).toBe("POST");
        expect(init.headers).toMatchObject({
          Authorization: "assembly-key",
          "X-AAI-Model": "universal-3-5-pro",
        });
        expect(String((init.headers as Record<string, string>)["Content-Type"])).toMatch(
          /^multipart\/form-data; boundary=/u,
        );
        const payload = await new Response(init.body as ReadableStream<Uint8Array>).arrayBuffer();
        const wire = Buffer.from(payload).toString("utf8");
        expect(wire.indexOf('name="config"')).toBeLessThan(wire.indexOf('name="audio"'));
        expect(wire).toContain('"sample_rate":16000');
        expect(wire).toContain('"channels":1');
        expect(wire).toContain("audio/pcm");
        expect(payload.byteLength).toBeGreaterThan(3_200);
        return new Response(
          JSON.stringify({
            text: "Hello from Sync live.",
            session_id: "sync-live-session-1",
            confidence: 0.92,
            audio_duration_ms: 100,
            request_time_ms: 88.2,
            words: [{ text: "Hello", confidence: 0.92 }],
          }),
          { status: 200 },
        );
      },
    });

    async function* chunks(): AsyncGenerator<Uint8Array> {
      yield new Uint8Array(1_600);
      yield new Uint8Array(1_600);
    }

    const result = await provider.transcribeSyncLive({
      audio: chunks(),
      format: SYNC_FORMAT,
      fileName: "live recording.pcm",
      timestamps: true,
    });

    expect(requests[0]?.url).toBe("https://sync.example.test/v1/transcribe/live");
    expect(result).toMatchObject({
      sessionId: "sync-live-session-1",
      modelId: "universal-3-5-pro",
      text: "Hello from Sync live.",
      audioDurationMs: 100,
    });
  });

  it("rejects Sync's unsupported model and duration boundary before HTTP", async () => {
    let calls = 0;
    const provider = new AssemblyAiSttProvider({
      apiKey: "assembly-key",
      fetchImpl: async () => {
        calls += 1;
        return new Response("{}", { status: 200 });
      },
    });

    await expect(
      provider.transcribeSync({ audio: SYNC_AUDIO, format: SYNC_FORMAT, model: "universal-2" }),
    ).rejects.toMatchObject({ code: "provider.model_unsupported" });
    await expect(
      provider.transcribeSync({ audio: new Uint8Array(2_000), format: SYNC_FORMAT }),
    ).rejects.toMatchObject({ code: "provider.invalid_request" });
    expect(calls).toBe(0);
  });

  it("publishes the current transport-specific model matrix", () => {
    const provider = new AssemblyAiSttProvider({ apiKey: "assembly-key" });
    expect(provider.capabilities.transports).toEqual(["http", "websocket"]);
    expect(provider.capabilities.models).toEqual([
      ...new Set([
        ...ASSEMBLYAI_REALTIME_MODELS,
        ...ASSEMBLYAI_PRE_RECORDED_MODELS,
        ...ASSEMBLYAI_SYNC_MODELS,
      ]),
    ]);
    expect(provider.capabilities.metadata).toMatchObject({
      realtimeModels: ASSEMBLYAI_REALTIME_MODELS,
      preRecordedModels: ASSEMBLYAI_PRE_RECORDED_MODELS,
      syncModels: ASSEMBLYAI_SYNC_MODELS,
    });
  });
});
