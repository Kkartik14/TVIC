import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PCM16_16K_MONO, type AudioFormat, type TranscriptEvent } from "@tvic/core";
import { resamplePcm16le, splitPcm16leFrames } from "../packages/media/dist/index.js";
import {
  ASSEMBLYAI_PRE_RECORDED_MODELS,
  ASSEMBLYAI_REALTIME_MODELS,
  ASSEMBLYAI_SYNC_MODELS,
  createAssemblyAiSttProvider,
} from "../packages/providers/dist/index.js";
import { createSttSession } from "../packages/runtime/dist/index.js";

import { readPcm16Wav } from "../examples/stt-only/src/wav.js";

type SmokeStatus = "passed" | "blocked" | "failed";
type SmokeResult = {
  readonly name: string;
  readonly status: SmokeStatus;
  readonly detail: string;
};
type AudioFixture = {
  readonly audio: Uint8Array;
  readonly wav: Uint8Array;
};

loadLocalEnv();

void main().catch((error: unknown) => {
  console.error(describeError(error));
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const apiKey = requiredEnv("ASSEMBLYAI_API_KEY");
  const inputPath = process.argv.slice(2).find((argument) => argument !== "--");
  if (!inputPath) {
    throw new Error("Usage: pnpm assemblyai:live-model-smoke -- ./speech.wav");
  }

  const maxAudioMs = readPositiveNumber("ASSEMBLYAI_SMOKE_MAX_AUDIO_MS", 5_000);
  if (maxAudioMs < 100) {
    throw new Error("ASSEMBLYAI_SMOKE_MAX_AUDIO_MS must be at least 100ms");
  }
  const timeoutMs = readPositiveNumber("ASSEMBLYAI_SMOKE_TIMEOUT_MS", 120_000);
  const fixture = await readFixture(inputPath, maxAudioMs);
  const trailingSilenceMs = readPositiveNumber("ASSEMBLYAI_SMOKE_TRAILING_SILENCE_MS", 1_000);
  const realtimeAudio = appendSilence(fixture.audio, trailingSilenceMs);
  const results: SmokeResult[] = [];

  console.log(
    `AssemblyAI model matrix: realtime=${ASSEMBLYAI_REALTIME_MODELS.length}, ` +
      `pre-recorded=${ASSEMBLYAI_PRE_RECORDED_MODELS.length}, ` +
      `sync=${ASSEMBLYAI_SYNC_MODELS.length}; fixture=${inputPath}, ` +
      `audio_ms=${Math.round((fixture.audio.byteLength / 2 / 16_000) * 1_000)}, ` +
      `realtime_audio_ms=${Math.round((realtimeAudio.byteLength / 2 / 16_000) * 1_000)}`,
  );

  for (const model of ASSEMBLYAI_REALTIME_MODELS) {
    results.push(
      await runCase(`realtime:${model}`, () =>
        runRealtime(apiKey, model, realtimeAudio, timeoutMs),
      ),
    );
  }
  for (const model of ASSEMBLYAI_PRE_RECORDED_MODELS) {
    results.push(
      await runCase(`pre-recorded:${model}`, () =>
        runPreRecorded(apiKey, model, fixture.wav, timeoutMs),
      ),
    );
  }
  const publicAudioUrl = process.env.ASSEMBLYAI_SMOKE_AUDIO_URL?.trim();
  if (publicAudioUrl) {
    results.push(
      await runCase("pre-recorded:public-url", () =>
        runPreRecordedUrl(apiKey, publicAudioUrl, timeoutMs),
      ),
    );
  }
  for (const model of ASSEMBLYAI_SYNC_MODELS) {
    results.push(
      await runCase(`sync:${model}`, () => runSync(apiKey, model, fixture.audio, timeoutMs)),
    );
    results.push(
      await runCase(`sync-live:${model}`, () =>
        runSyncLive(apiKey, model, fixture.audio, timeoutMs),
      ),
    );
  }

  console.log("\nAssemblyAI model summary:");
  for (const result of results) {
    console.log(`- ${result.name}: ${result.status} (${result.detail})`);
  }

  const failed = results.filter((result) => result.status === "failed");
  const blocked = results.filter((result) => result.status === "blocked");
  if (failed.length > 0 || (blocked.length > 0 && process.env.LIVE_SMOKE_ALLOW_BLOCKED !== "1")) {
    process.exitCode = 1;
  }
}

async function runRealtime(
  apiKey: string,
  model: string,
  audio: Uint8Array,
  timeoutMs: number,
): Promise<string> {
  const provider = createAssemblyAiSttProvider({ apiKey, modelId: model });
  const controller = new AbortController();
  const deadlineTimer = setTimeout(() => controller.abort(), timeoutMs);
  let session: Awaited<ReturnType<typeof createSttSession>> | undefined;
  let eventsDone: Promise<void> | undefined;

  let partials = 0;
  let finals = 0;
  let textChars = 0;
  let resolveFinal: (() => void) | undefined;
  const finalSeen = new Promise<void>((resolve) => {
    resolveFinal = resolve;
  });
  let eventError: unknown;

  try {
    session = await createSttSession({
      provider,
      format: PCM16_16K_MONO,
      input: { format: PCM16_16K_MONO, normalization: "never" },
      interimResults: true,
      signal: controller.signal,
      closeTimeoutMs: 5_000,
    });
    eventsDone = consumeEvents(session.events, (event) => {
      if (event.type === "stt.partial") {
        partials += 1;
        textChars = Math.max(textChars, event.text.length);
      }
      if (event.type === "stt.final") {
        finals += 1;
        textChars = Math.max(textChars, event.text.length);
        resolveFinal?.();
        resolveFinal = undefined;
      }
    }).catch((error: unknown) => {
      eventError = error;
    });
    for (const frame of splitPcm16leFrames(audio, PCM16_16K_MONO, 20)) {
      await session.pushPcm16(frame);
    }
    await session.commit();
    try {
      await withTimeout(finalSeen, timeoutMs);
    } catch {
      throw new Error(`realtime final timed out after ${timeoutMs}ms`);
    }
  } finally {
    clearTimeout(deadlineTimer);
    if (session) await session.close().catch(() => undefined);
  }
  if (eventsDone) await withTimeout(eventsDone, 5_000);
  if (eventError) throw eventError;
  if (finals === 0 || textChars === 0) {
    throw new Error(
      `realtime returned no non-empty final (partials=${partials}, finals=${finals})`,
    );
  }
  return `transport=websocket, partials=${partials}, finals=${finals}, textChars=${textChars}`;
}

async function runPreRecorded(
  apiKey: string,
  model: string,
  wav: Uint8Array,
  timeoutMs: number,
): Promise<string> {
  const provider = createAssemblyAiSttProvider({ apiKey });
  const controller = new AbortController();
  const deadlineTimer = setTimeout(() => controller.abort(), timeoutMs);
  let result: Awaited<ReturnType<typeof provider.transcribe>>;
  try {
    result = await provider.transcribe({
      audio: wav,
      mimeType: "audio/wav",
      fileName: "assemblyai-model-smoke.wav",
      model,
      pollIntervalMs: 1_000,
      pollTimeoutMs: timeoutMs,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(deadlineTimer);
  }
  if (result.text.trim().length === 0) {
    throw new Error("pre-recorded returned an empty transcript");
  }
  return `transport=http, words=${result.words.length}, textChars=${result.text.length}, duration_ms=${result.audioDurationMs ?? "unknown"}`;
}

async function runPreRecordedUrl(
  apiKey: string,
  audioUrl: string,
  timeoutMs: number,
): Promise<string> {
  const provider = createAssemblyAiSttProvider({ apiKey });
  const controller = new AbortController();
  const deadlineTimer = setTimeout(() => controller.abort(), timeoutMs);
  let result: Awaited<ReturnType<typeof provider.transcribe>>;
  try {
    result = await provider.transcribe({
      audioUrl,
      model: "universal-3-5-pro",
      pollIntervalMs: 1_000,
      pollTimeoutMs: timeoutMs,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(deadlineTimer);
  }
  if (result.text.trim().length === 0) {
    throw new Error("pre-recorded public URL returned an empty transcript");
  }
  return `transport=http-url, words=${result.words.length}, textChars=${result.text.length}, duration_ms=${result.audioDurationMs ?? "unknown"}`;
}

async function runSync(
  apiKey: string,
  model: string,
  audio: Uint8Array,
  timeoutMs: number,
): Promise<string> {
  const provider = createAssemblyAiSttProvider({ apiKey });
  const controller = new AbortController();
  const deadlineTimer = setTimeout(() => controller.abort(), timeoutMs);
  let result: Awaited<ReturnType<typeof provider.transcribeSync>>;
  try {
    await provider.warmSync(model, controller.signal);
    result = await provider.transcribeSync({
      audio,
      format: PCM16_16K_MONO,
      model,
      languageCodes: ["en"],
      timestamps: true,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(deadlineTimer);
  }
  if (result.text.trim().length === 0) {
    throw new Error("Sync returned an empty transcript");
  }
  return `transport=sync-http, words=${result.words.length}, textChars=${result.text.length}, duration_ms=${result.audioDurationMs ?? "unknown"}`;
}

async function runSyncLive(
  apiKey: string,
  model: string,
  audio: Uint8Array,
  timeoutMs: number,
): Promise<string> {
  const provider = createAssemblyAiSttProvider({ apiKey });
  const controller = new AbortController();
  const deadlineTimer = setTimeout(() => controller.abort(), timeoutMs);
  let result: Awaited<ReturnType<typeof provider.transcribeSyncLive>>;
  try {
    result = await provider.transcribeSyncLive({
      audio: streamPcmChunks(audio),
      format: PCM16_16K_MONO,
      model,
      languageCodes: ["en"],
      timestamps: true,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(deadlineTimer);
  }
  if (result.text.trim().length === 0) {
    throw new Error("Sync live returned an empty transcript");
  }
  return `transport=sync-http-live, words=${result.words.length}, textChars=${result.text.length}, duration_ms=${result.audioDurationMs ?? "unknown"}`;
}

async function* streamPcmChunks(audio: Uint8Array): AsyncGenerator<Uint8Array> {
  for (const chunk of splitPcm16leFrames(audio, PCM16_16K_MONO, 100)) {
    await delay(20);
    yield chunk;
  }
}

async function readFixture(path: string, maxAudioMs: number): Promise<AudioFixture> {
  const source = await readPcm16Wav(path);
  const audio =
    source.format.sampleRateHz === PCM16_16K_MONO.sampleRateHz
      ? source.bytes
      : resamplePcm16le(source.bytes, source.format.sampleRateHz, PCM16_16K_MONO.sampleRateHz);
  const maxBytes = Math.floor((PCM16_16K_MONO.sampleRateHz * maxAudioMs) / 1_000) * 2;
  const capped = audio.slice(0, Math.min(audio.byteLength, maxBytes) & ~1);
  return { audio: capped, wav: pcmWav(capped, PCM16_16K_MONO) };
}

function pcmWav(audio: Uint8Array, format: AudioFormat): Uint8Array {
  const bytesPerSample = 2;
  const blockAlign = format.channels * bytesPerSample;
  const byteRate = format.sampleRateHz * blockAlign;
  const output = new Uint8Array(44 + audio.byteLength);
  const view = new DataView(output.buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + audio.byteLength, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, format.channels, true);
  view.setUint32(24, format.sampleRateHz, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, audio.byteLength, true);
  output.set(audio, 44);
  return output;
}

function appendSilence(audio: Uint8Array, durationMs: number): Uint8Array {
  const silenceBytes = Math.floor((PCM16_16K_MONO.sampleRateHz * durationMs) / 1_000) * 2;
  const output = new Uint8Array(audio.byteLength + silenceBytes);
  output.set(audio);
  return output;
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

async function consumeEvents(
  events: AsyncIterable<TranscriptEvent>,
  observe: (event: TranscriptEvent) => void,
): Promise<void> {
  for await (const event of events) observe(event);
}

async function runCase(name: string, operation: () => Promise<string>): Promise<SmokeResult> {
  const startedAt = Date.now();
  let result: SmokeResult;
  try {
    const detail = await operation();
    result = { name, status: "passed", detail: `${detail}; ${Date.now() - startedAt}ms` };
  } catch (error) {
    const detail = describeError(error);
    result = {
      name,
      status: isBlockedError(error) ? "blocked" : "failed",
      detail: `${detail}; ${Date.now() - startedAt}ms`,
    };
  }
  console.log(`[assemblyai] ${result.name}: ${result.status} (${result.detail})`);
  return result;
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
    code.includes("auth_failed") ||
    code.includes("rate_limited") ||
    code.includes("quota") ||
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
    if (timer !== undefined) clearTimeout(timer);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
