import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PCM16_16K_MONO, type AudioFormat, type TranscriptEvent, type TtsEvent } from "@tvic/core";
import {
  createElevenLabsSttProvider,
  createElevenLabsTtsProvider,
  PROVIDER_CATALOG,
} from "../packages/providers/dist/index.js";
import { resamplePcm16le, splitPcm16leFrames } from "../packages/media/dist/index.js";
import { createSttSession } from "../packages/runtime/dist/index.js";

import { readPcm16Wav } from "../examples/stt-only/src/wav.js";

type SmokeStatus = "passed" | "blocked" | "failed";
type SmokeResult<T = never> = {
  readonly name: string;
  readonly status: SmokeStatus;
  readonly detail: string;
  readonly value?: T;
};
type AudioFixture = {
  readonly audio: Uint8Array;
  readonly format: AudioFormat;
};
type TtsOutput = {
  readonly audio: Uint8Array;
  readonly detail: string;
};

loadLocalEnv();

void main().catch((error: unknown) => {
  console.error(describeError(error));
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const apiKey = requiredEnv("ELEVENLABS_API_KEY");
  const voiceId = requiredEnv("ELEVENLABS_VOICE_ID");
  const inputPath = process.argv.slice(2).find((argument) => !argument.startsWith("--"));
  const maxAudioMs = readPositiveNumber("ELEVENLABS_SMOKE_MAX_AUDIO_MS", 8_000);
  const waitMs = readPositiveNumber("ELEVENLABS_SMOKE_WAIT_MS", 30_000);
  const entityDetection = process.env.ELEVENLABS_SMOKE_ENTITY_DETECTION?.trim() || undefined;

  let fixture = inputPath ? await readFixture(inputPath, maxAudioMs) : undefined;
  const results: SmokeResult<unknown>[] = [];

  console.log(
    `ElevenLabs model smoke: ${PROVIDER_CATALOG.elevenlabs.models.length} TTS models, ` +
      `${PROVIDER_CATALOG.elevenlabsStt.models.length} STT models`,
  );

  for (const model of PROVIDER_CATALOG.elevenlabs.models) {
    const result = await runCase<TtsOutput>(`tts:${model}`, () =>
      runTtsModel(apiKey, voiceId, model),
    );
    results.push(result);
    if (!fixture && result.status === "passed" && result.value) {
      fixture = {
        audio: capAudio(result.value.audio, maxAudioMs),
        format: PCM16_16K_MONO,
      };
    }
  }

  if (fixture) {
    console.log(`STT fixture ready (${fixture.audio.byteLength} PCM bytes)`);
    for (const model of PROVIDER_CATALOG.elevenlabsStt.models) {
      const result = await runCase(`stt:${model}`, () =>
        runSttModel(apiKey, model, fixture!, waitMs, entityDetection),
      );
      results.push(result);
    }
  } else {
    for (const model of PROVIDER_CATALOG.elevenlabsStt.models) {
      results.push({
        name: `stt:${model}`,
        status: "blocked",
        detail:
          "no 16kHz PCM fixture available; provide a WAV path or allow a TTS model to produce one",
      });
    }
  }

  console.log("\nElevenLabs model summary:");
  for (const result of results) {
    console.log(`- ${result.name}: ${result.status} (${result.detail})`);
  }

  const failed = results.filter((result) => result.status === "failed");
  const blocked = results.filter((result) => result.status === "blocked");
  if (failed.length > 0 || (blocked.length > 0 && process.env.LIVE_SMOKE_ALLOW_BLOCKED !== "1")) {
    process.exitCode = 1;
  }
}

async function runTtsModel(apiKey: string, voiceId: string, model: string): Promise<TtsOutput> {
  const provider = createElevenLabsTtsProvider({
    apiKey,
    voiceId,
    modelId: model,
  });
  const stream = await provider.synthesize({
    sessionId: `elevenlabs_smoke_${model}` as never,
    turnId: `elevenlabs_tts_${model}` as never,
    text: "TVIC model compatibility test.",
    format: PCM16_16K_MONO,
    timestamps: true,
    stream: true,
  });

  const chunks: Uint8Array[] = [];
  let committed = 0;
  let alignments = 0;
  try {
    for await (const event of stream.events) {
      observeTtsEvent(
        event,
        chunks,
        () => {
          committed += 1;
        },
        () => {
          alignments += 1;
        },
      );
    }
  } finally {
    await stream.cancel();
  }
  const audio = joinBytes(chunks);
  if (audio.byteLength === 0 || committed !== 1) {
    throw new Error(`invalid TTS output bytes=${audio.byteLength}, committed=${committed}`);
  }
  return {
    audio,
    detail: `chunks=${chunks.length}, alignments=${alignments}, bytes=${audio.byteLength}`,
  };
}

async function runSttModel(
  apiKey: string,
  model: string,
  fixture: AudioFixture,
  waitMs: number,
  entityDetection?: string,
): Promise<string> {
  const provider = createElevenLabsSttProvider({
    apiKey,
    modelId: model,
    ...(model === "scribe_v2_realtime"
      ? {
          includeTimestamps: true,
          includeLanguageDetection: true,
          ...(entityDetection ? { entityDetection } : {}),
        }
      : {}),
  });
  if (model === "scribe_v2_realtime") {
    return runRealtimeStt(provider, fixture, waitMs, entityDetection !== undefined);
  }
  const result = await provider.transcribe({
    audio: fixture.audio,
    format: PCM16_16K_MONO,
    model,
    tagAudioEvents: true,
    timestampsGranularity: "word",
    noVerbatim: true,
  });
  if (result.text.trim().length === 0) {
    throw new Error("batch STT returned an empty transcript");
  }
  return `transport=http, words=${result.words.length}, textChars=${result.text.length}`;
}

async function runRealtimeStt(
  provider: ReturnType<typeof createElevenLabsSttProvider>,
  fixture: AudioFixture,
  waitMs: number,
  expectEntityEvent: boolean,
): Promise<string> {
  const session = await createSttSession({
    provider,
    format: PCM16_16K_MONO,
    input: { format: fixture.format, normalization: "auto" },
    interimResults: true,
  });
  let partials = 0;
  let finals = 0;
  let textChars = 0;
  let timestampedWords = 0;
  let entityRecords = 0;
  let resolveFinal: (() => void) | undefined;
  const finalSeen = new Promise<void>((resolve) => {
    resolveFinal = resolve;
  });
  let eventError: unknown;
  const eventsDone = consumeSttEvents(session.events, (event) => {
    if (event.type === "stt.partial") {
      partials += 1;
      textChars = event.text.length;
    }
    if (event.type === "stt.final") {
      finals += 1;
      textChars = event.text.length;
      const metadata = event.metadata?.["elevenlabs"];
      if (typeof metadata === "object" && metadata !== null) {
        const words = (metadata as { readonly words?: unknown }).words;
        if (Array.isArray(words)) timestampedWords += words.length;
        const entities = (metadata as { readonly entities?: unknown }).entities;
        if (Array.isArray(entities)) entityRecords += 1;
      }
      resolveFinal?.();
      resolveFinal = undefined;
    }
  }).catch((error: unknown) => {
    eventError = error;
  });

  try {
    for (const frame of splitPcm16leFrames(fixture.audio, PCM16_16K_MONO, 20)) {
      await session.pushPcm16(frame);
    }
    await session.commit();
    await waitForFinalOrTimeout(finalSeen, waitMs);
  } finally {
    await session.close();
  }
  await eventsDone;
  if (eventError) throw eventError;
  if (
    finals === 0 ||
    textChars === 0 ||
    timestampedWords === 0 ||
    (expectEntityEvent && entityRecords === 0)
  ) {
    throw new Error(
      `realtime STT returned incomplete final evidence (partials=${partials}, words=${timestampedWords}, entityEvents=${entityRecords})`,
    );
  }
  return `transport=websocket, partials=${partials}, finals=${finals}, words=${timestampedWords}, entityEvents=${entityRecords}, textChars=${textChars}`;
}

function observeTtsEvent(
  event: TtsEvent,
  chunks: Uint8Array[],
  onCommitted: () => void,
  onAlignment: () => void,
): void {
  if (event.type === "media.audio.chunk") chunks.push(event.audio.bytes);
  if (event.type === "media.audio.committed") onCommitted();
  if (event.type === "tts.alignment") onAlignment();
}

async function consumeSttEvents(
  events: AsyncIterable<TranscriptEvent>,
  observe: (event: TranscriptEvent) => void,
): Promise<void> {
  for await (const event of events) observe(event);
}

async function readFixture(path: string, maxAudioMs: number): Promise<AudioFixture> {
  const wav = await readPcm16Wav(path);
  const audio =
    wav.format.sampleRateHz === PCM16_16K_MONO.sampleRateHz
      ? wav.bytes
      : resamplePcm16le(wav.bytes, wav.format.sampleRateHz, PCM16_16K_MONO.sampleRateHz);
  return { audio: capAudio(audio, maxAudioMs), format: PCM16_16K_MONO };
}

function capAudio(audio: Uint8Array, maxAudioMs: number): Uint8Array {
  const maxBytes = Math.floor((PCM16_16K_MONO.sampleRateHz * maxAudioMs) / 1_000) * 2;
  const length = Math.min(audio.byteLength, maxBytes);
  return audio.slice(0, length - (length % 2));
}

function joinBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function runCase<T>(name: string, operation: () => Promise<T>): Promise<SmokeResult<T>> {
  const startedAt = Date.now();
  try {
    const value = await withTimeout(
      operation(),
      readPositiveNumber("ELEVENLABS_SMOKE_TIMEOUT_MS", 45_000),
    );
    const detail =
      value && typeof value === "object" && "detail" in value
        ? String((value as { detail: unknown }).detail)
        : String(value);
    return { name, status: "passed", detail: `${detail}; ${Date.now() - startedAt}ms`, value };
  } catch (error) {
    const detail = describeError(error);
    return {
      name,
      status: isBlockedError(error) ? "blocked" : "failed",
      detail: `${detail}; ${Date.now() - startedAt}ms`,
    };
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required env var ${name}`);
  return value;
}

function isBlockedError(error: unknown): boolean {
  const code = errorObjectField(error, "code")?.toLowerCase() ?? "";
  const message = describeError(error).toLowerCase();
  return (
    code.includes("rate_limited") ||
    code.includes("quota") ||
    code.includes("auth_failed") ||
    message.includes("missing required env var") ||
    message.includes("balance") ||
    message.includes("quota") ||
    message.includes("credit") ||
    message.includes("rate limit") ||
    message.includes("insufficient") ||
    message.includes("unauthorized") ||
    message.includes("forbidden") ||
    message.includes("permission") ||
    message.includes("access denied")
  );
}

function describeError(error: unknown): string {
  const code = errorObjectField(error, "code");
  const message = errorObjectField(error, "message");
  if (code && message) return `${code}: ${message}`;
  return error instanceof Error ? error.message : String(error);
}

function errorObjectField(error: unknown, field: string): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const value = (error as Record<string, unknown>)[field];
  return typeof value === "string" ? value : undefined;
}

function readPositiveNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number`);
  }
  return value;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`operation timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForFinalOrTimeout(finalSeen: Promise<void>, waitMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      finalSeen,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, waitMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function loadLocalEnv(): void {
  if (process.env.NODE_ENV === "production" || process.env.TVIC_ENV === "production") return;
  let source: string;
  try {
    source = readFileSync(fileURLToPath(new URL("../.env", import.meta.url)), "utf8");
  } catch {
    return;
  }
  for (const line of source.split(/\r?\n/u)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/u.exec(line);
    if (!match || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = parseEnvValue(match[2] ?? "");
  }
}

function parseEnvValue(raw: string): string {
  if (raw.length >= 2) {
    const first = raw[0];
    const last = raw.at(-1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return raw.slice(1, -1);
    }
  }
  const comment = raw.indexOf(" #");
  return comment >= 0 ? raw.slice(0, comment).trimEnd() : raw;
}
