import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PCM16_16K_MONO, type AudioFormat, type TranscriptEvent } from "@tvic/core";
import { resamplePcm16le, splitPcm16leFrames } from "../packages/media/dist/index.js";
import {
  ASSEMBLYAI_REALTIME_MODELS,
  createAssemblyAiSttProvider,
  type AssemblyAiSttProvider,
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
  readonly pcm: Uint8Array;
  readonly wav: Uint8Array;
  readonly stereoWav: Uint8Array;
};

loadLocalEnv();

void main().catch((error: unknown) => {
  console.error(describeError(error));
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const apiKey = requiredEnv("ASSEMBLYAI_API_KEY");
  const inputPath = process.argv.slice(2).find((argument) => argument !== "--");
  if (!inputPath) throw new Error("Usage: pnpm assemblyai:deep-smoke -- ./speech.wav");

  const repeats = readPositiveInteger("ASSEMBLYAI_DEEP_REPEATS", 2);
  const timeoutMs = readPositiveInteger("ASSEMBLYAI_DEEP_TIMEOUT_MS", 120_000);
  const maxAudioMs = readPositiveInteger("ASSEMBLYAI_DEEP_MAX_AUDIO_MS", 30_000);
  const fixture = await readFixture(inputPath, maxAudioMs);
  const realtimeAudio = appendSilence(fixture.pcm, 1_000);
  const results: SmokeResult[] = [];
  let realtimeNextAllowedAt = 0;

  console.log(
    `AssemblyAI deep smoke: repeats=${repeats}, fixture=${inputPath}, ` +
      `audio_ms=${Math.round((fixture.pcm.byteLength / 2 / 16_000) * 1_000)}`,
  );

  for (let repeat = 1; repeat <= repeats; repeat += 1) {
    for (const model of ASSEMBLYAI_REALTIME_MODELS) {
      results.push(
        await runRealtimeSmokeCase(
          `realtime:${model}:run-${repeat}`,
          () => runRealtimeCase(apiKey, model, realtimeAudio, timeoutMs),
          () => realtimeNextAllowedAt,
          (value) => {
            realtimeNextAllowedAt = value;
          },
        ),
      );
    }
  }

  results.push(
    await runRealtimeSmokeCase(
      "realtime:prompt-keyterms-diarization",
      () => runRealtimeFeatureCase(apiKey, realtimeAudio, timeoutMs),
      () => realtimeNextAllowedAt,
      (value) => {
        realtimeNextAllowedAt = value;
      },
    ),
  );
  results.push(
    await runRealtimeSmokeCase(
      "realtime:unformatted-turns",
      () => runRealtimeUnformattedCase(apiKey, realtimeAudio, timeoutMs),
      () => realtimeNextAllowedAt,
      (value) => {
        realtimeNextAllowedAt = value;
      },
    ),
  );
  results.push(
    await runRealtimeSmokeCase(
      "realtime:two-forced-endpoints",
      () => runRealtimeMultiTurnCase(apiKey, realtimeAudio, timeoutMs),
      () => realtimeNextAllowedAt,
      (value) => {
        realtimeNextAllowedAt = value;
      },
    ),
  );

  results.push(
    await runCase("pre-recorded:prompt-keyterms-speakers", () =>
      runPreRecordedFeatureCase(apiKey, fixture.wav, timeoutMs),
    ),
  );
  results.push(
    await runCase("pre-recorded:multichannel", () =>
      runPreRecordedMultichannelCase(apiKey, fixture.stereoWav, timeoutMs),
    ),
  );
  results.push(
    await runCase("pre-recorded:pii-redaction", () =>
      runPreRecordedRedactionCase(apiKey, fixture.wav, timeoutMs),
    ),
  );
  results.push(
    await runCase("pre-recorded:default-model-fallback", () =>
      runPreRecordedFallbackCase(apiKey, timeoutMs),
    ),
  );

  for (let repeat = 1; repeat <= repeats; repeat += 1) {
    results.push(
      await runCase(`sync:options:run-${repeat}`, () =>
        runSyncOptionsCase(apiKey, fixture.pcm, timeoutMs),
      ),
    );
    results.push(
      await runCase(`sync-live:chunked:run-${repeat}`, () =>
        runSyncLiveCase(apiKey, fixture.pcm, timeoutMs),
      ),
    );
  }

  results.push(
    await runCase("http:provider-error-normalization", () =>
      runProviderErrorCase(apiKey, timeoutMs),
    ),
  );

  console.log("\nAssemblyAI deep smoke summary:");
  for (const result of results) {
    console.log(`- ${result.name}: ${result.status} (${result.detail})`);
  }
  const failed = results.filter((result) => result.status === "failed");
  const blocked = results.filter((result) => result.status === "blocked");
  console.log(
    `\n${results.length - failed.length - blocked.length}/${results.length} cases passed; ` +
      `${blocked.length} blocked, ${failed.length} failed`,
  );
  if (failed.length > 0 || (blocked.length > 0 && process.env.LIVE_SMOKE_ALLOW_BLOCKED !== "1")) {
    process.exitCode = 1;
  }
}

async function runRealtimeSmokeCase(
  name: string,
  operation: () => Promise<string>,
  getNextAllowedAt: () => number,
  setNextAllowedAt: (value: number) => void,
): Promise<SmokeResult> {
  const gapMs = readPositiveInteger("ASSEMBLYAI_DEEP_REALTIME_GAP_MS", 8_000);
  const waitMs = getNextAllowedAt() - Date.now();
  if (waitMs > 0) await delay(waitMs);
  let result = await runCase(name, operation);
  if (result.status === "blocked" && /too many concurrent sessions/iu.test(result.detail)) {
    const retryDelayMs = readPositiveInteger("ASSEMBLYAI_DEEP_REALTIME_RETRY_MS", 15_000);
    console.log(`[assemblyai] ${name}: waiting ${retryDelayMs}ms for realtime capacity retry`);
    await delay(retryDelayMs);
    result = await runCase(name, operation);
    if (result.status === "passed") {
      result = { ...result, detail: `${result.detail}; recovered after concurrency retry` };
    }
  }
  setNextAllowedAt(Date.now() + gapMs);
  return result;
}

async function runRealtimeCase(
  apiKey: string,
  model: string,
  audio: Uint8Array,
  timeoutMs: number,
): Promise<string> {
  const events = await collectRealtime(
    createAssemblyAiSttProvider({ apiKey, modelId: model }),
    model,
    audio,
    timeoutMs,
    1,
  );
  return summarizeRealtime(events);
}

async function runRealtimeFeatureCase(
  apiKey: string,
  audio: Uint8Array,
  timeoutMs: number,
): Promise<string> {
  const events = await collectRealtime(
    createAssemblyAiSttProvider({
      apiKey,
      modelId: "universal-3-6-pro",
      languageDetection: true,
      speakerLabels: true,
      maxSpeakers: 2,
      speakerLabelsRevisionIntervalMs: 0,
      prompt: "A TVIC support conversation about speech recognition.",
    }),
    "universal-3-6-pro",
    audio,
    timeoutMs,
    1,
    ["TVIC", "AssemblyAI"],
  );
  const final = events.find((event) => event.type === "stt.final");
  const metadata = final?.metadata?.assemblyai;
  if (
    !metadata ||
    typeof metadata !== "object" ||
    typeof (metadata as Record<string, unknown>).speakerLabel !== "string"
  ) {
    throw new Error("realtime diarization returned no speaker label metadata");
  }
  return `${summarizeRealtime(events)}, speakerLabel=present`;
}

async function runRealtimeUnformattedCase(
  apiKey: string,
  audio: Uint8Array,
  timeoutMs: number,
): Promise<string> {
  const events = await collectRealtime(
    createAssemblyAiSttProvider({
      apiKey,
      modelId: "universal-streaming-english",
      formatTurns: false,
    }),
    "universal-streaming-english",
    audio,
    timeoutMs,
    1,
  );
  return summarizeRealtime(events);
}

async function runRealtimeMultiTurnCase(
  apiKey: string,
  audio: Uint8Array,
  timeoutMs: number,
): Promise<string> {
  const events = await collectRealtime(
    createAssemblyAiSttProvider({ apiKey, modelId: "universal-3-6-pro" }),
    "universal-3-6-pro",
    audio,
    timeoutMs,
    2,
    [],
    [audio],
  );
  return summarizeRealtime(events);
}

async function collectRealtime(
  provider: AssemblyAiSttProvider,
  model: string,
  audio: Uint8Array,
  timeoutMs: number,
  expectedFinals: number,
  vocabulary: readonly string[] = [],
  additionalSegments: readonly Uint8Array[] = [],
): Promise<readonly TranscriptEvent[]> {
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), timeoutMs);
  let session: Awaited<ReturnType<typeof createSttSession>> | undefined;
  const events: TranscriptEvent[] = [];
  let eventError: unknown;
  try {
    session = await createSttSession({
      provider,
      format: PCM16_16K_MONO,
      input: { format: PCM16_16K_MONO, normalization: "never" },
      model,
      vocabulary,
      interimResults: true,
      signal: controller.signal,
      closeTimeoutMs: 5_000,
    });
    const eventsDone = consumeEvents(session.events, events).catch((error: unknown) => {
      eventError = error;
    });
    const segments = [audio, ...additionalSegments];
    for (const [index, segment] of segments.entries()) {
      for (const frame of splitPcm16leFrames(segment, PCM16_16K_MONO, 20)) {
        await session.pushPcm16(frame);
      }
      await session.commit();
      await waitForFinalCount(events, Math.min(index + 1, expectedFinals), timeoutMs, () => {
        if (eventError) throw eventError;
      });
    }
    if (eventError) throw eventError;
    await session.close();
    await withTimeout(eventsDone, 5_000);
    if (eventError) throw eventError;
    const finals = events.filter((event) => event.type === "stt.final");
    if (finals.length < expectedFinals) {
      throw new Error(`expected ${expectedFinals} realtime finals, got ${finals.length}`);
    }
    return events;
  } finally {
    clearTimeout(abortTimer);
    if (session) await session.close().catch(() => undefined);
  }
}

async function runPreRecordedFeatureCase(
  apiKey: string,
  wav: Uint8Array,
  timeoutMs: number,
): Promise<string> {
  const result = await createAssemblyAiSttProvider({ apiKey }).transcribe({
    audio: wav,
    mimeType: "audio/wav",
    model: "universal-3-5-pro",
    languageDetection: true,
    prompt: "A short TVIC support conversation about speech recognition.",
    vocabulary: ["TVIC", "AssemblyAI"],
    punctuate: true,
    formatText: true,
    disfluencies: true,
    speakerLabels: true,
    speakerOptions: {
      minSpeakersExpected: 1,
      maxSpeakersExpected: 2,
      includeSpeakerConfidence: true,
    },
    pollIntervalMs: 1_000,
    pollTimeoutMs: timeoutMs,
  });
  assertTranscript(result.text, "pre-recorded feature");
  if (result.words.length === 0 || result.utterances.length === 0) {
    throw new Error("pre-recorded feature response omitted words or utterances");
  }
  return `words=${result.words.length}, utterances=${result.utterances.length}, model=${result.modelId}`;
}

async function runPreRecordedMultichannelCase(
  apiKey: string,
  wav: Uint8Array,
  timeoutMs: number,
): Promise<string> {
  const result = await createAssemblyAiSttProvider({ apiKey }).transcribe({
    audio: wav,
    mimeType: "audio/wav",
    model: "universal-2",
    languageDetection: true,
    multichannel: true,
    speakerLabels: true,
    speakerOptions: { minSpeakersExpected: 1, maxSpeakersExpected: 2 },
    pollIntervalMs: 1_000,
    pollTimeoutMs: timeoutMs,
  });
  assertTranscript(result.text, "pre-recorded multichannel");
  if (result.audioChannels !== 2) {
    throw new Error(`expected two audio channels, got ${result.audioChannels ?? "unknown"}`);
  }
  return `channels=${result.audioChannels}, utterances=${result.utterances.length}, model=${result.modelId}`;
}

async function runPreRecordedRedactionCase(
  apiKey: string,
  wav: Uint8Array,
  timeoutMs: number,
): Promise<string> {
  const result = await createAssemblyAiSttProvider({ apiKey }).transcribe({
    audio: wav,
    mimeType: "audio/wav",
    model: "universal-2",
    redactPii: true,
    redactPiiPolicies: ["person_name", "phone_number", "email_address"],
    redactPiiSub: "entity_name",
    redactPiiAudio: true,
    redactPiiAudioQuality: "wav",
    redactPiiAudioOptions: {
      overrideAudioRedactionMethod: "silence",
      returnRedactedNoSpeechAudio: true,
    },
    redactPiiReturnUnredacted: true,
    pollIntervalMs: 1_000,
    pollTimeoutMs: timeoutMs,
  });
  assertTranscript(result.text, "pre-recorded redaction");
  if (!("unredacted_text" in result.providerResponse)) {
    throw new Error("PII response omitted unredacted_text");
  }
  return `redaction-response=present, textChars=${result.text.length}`;
}

async function runPreRecordedFallbackCase(apiKey: string, timeoutMs: number): Promise<string> {
  const result = await createAssemblyAiSttProvider({ apiKey }).transcribe({
    audioUrl: process.env.ASSEMBLYAI_DEEP_PUBLIC_URL?.trim() ?? "https://assembly.ai/wildfires.mp3",
    languageDetection: true,
    pollIntervalMs: 1_000,
    pollTimeoutMs: timeoutMs,
  });
  assertTranscript(result.text, "pre-recorded fallback");
  if (result.modelId !== "universal-3-5-pro" && result.modelId !== "universal-2") {
    throw new Error(`unexpected fallback model ${result.modelId}`);
  }
  return `modelUsed=${result.modelId}, words=${result.words.length}`;
}

async function runSyncOptionsCase(
  apiKey: string,
  pcm: Uint8Array,
  timeoutMs: number,
): Promise<string> {
  const provider = createAssemblyAiSttProvider({ apiKey });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await provider.warmSync("universal-3-5-pro", controller.signal);
    const result = await provider.transcribeSync({
      audio: pcm,
      format: PCM16_16K_MONO,
      model: "universal-3-5-pro",
      languageCodes: ["en"],
      prompt: "A TVIC support conversation about speech recognition.",
      vocabulary: ["TVIC", "AssemblyAI"],
      timestamps: true,
      signal: controller.signal,
    });
    assertTranscript(result.text, "Sync options");
    if (result.words.length === 0) throw new Error("Sync options response omitted words");
    return `words=${result.words.length}, duration_ms=${result.audioDurationMs ?? "unknown"}`;
  } finally {
    clearTimeout(timer);
  }
}

async function runSyncLiveCase(
  apiKey: string,
  pcm: Uint8Array,
  timeoutMs: number,
): Promise<string> {
  const provider = createAssemblyAiSttProvider({ apiKey });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const result = await provider.transcribeSyncLive({
      audio: pacedPcmChunks(pcm),
      format: PCM16_16K_MONO,
      model: "universal-3-5-pro",
      languageCodes: ["en"],
      prompt: "A TVIC support conversation about speech recognition.",
      vocabulary: ["TVIC", "AssemblyAI"],
      timestamps: true,
      signal: controller.signal,
    });
    assertTranscript(result.text, "Sync live");
    if (result.words.length === 0) throw new Error("Sync live response omitted words");
    return `words=${result.words.length}, duration_ms=${result.audioDurationMs ?? "unknown"}`;
  } finally {
    clearTimeout(timer);
  }
}

async function runProviderErrorCase(apiKey: string, timeoutMs: number): Promise<string> {
  const provider = createAssemblyAiSttProvider({
    apiKey,
    preRecordedUrl: "https://api.assemblyai.com/v2/not-a-transcript-endpoint",
  });
  try {
    await provider.transcribe({
      audioUrl: "https://assembly.ai/wildfires.mp3",
      model: "universal-2",
      pollIntervalMs: 1_000,
      pollTimeoutMs: timeoutMs,
    });
  } catch (error) {
    const code = errorObjectField(error, "code");
    if (code !== "provider.invalid_request") {
      throw new Error(`expected real HTTP 404 normalization, got ${code ?? describeError(error)}`);
    }
    return `code=${code}`;
  }
  throw new Error("invalid AssemblyAI endpoint unexpectedly succeeded");
}

function summarizeRealtime(events: readonly TranscriptEvent[]): string {
  const partials = events.filter((event) => event.type === "stt.partial").length;
  const finals = events.filter((event) => event.type === "stt.final").length;
  const endpoints = events.filter((event) => event.type === "stt.endpoint").length;
  const textChars = events.reduce(
    (max, event) =>
      event.type === "stt.partial" || event.type === "stt.final"
        ? Math.max(max, event.text.length)
        : max,
    0,
  );
  return `partials=${partials}, finals=${finals}, endpoints=${endpoints}, textChars=${textChars}`;
}

async function consumeEvents(
  events: AsyncIterable<TranscriptEvent>,
  output: TranscriptEvent[],
): Promise<void> {
  for await (const event of events) output.push(event);
}

async function waitForFinalCount(
  events: readonly TranscriptEvent[],
  count: number,
  timeoutMs: number,
  onTick: () => void,
): Promise<void> {
  const startedAt = Date.now();
  while (events.filter((event) => event.type === "stt.final").length < count) {
    onTick();
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`timed out waiting for realtime final ${count}`);
    }
    await delay(50);
  }
}

async function* pacedPcmChunks(audio: Uint8Array): AsyncGenerator<Uint8Array> {
  for (const chunk of splitPcm16leFrames(audio, PCM16_16K_MONO, 100)) {
    await delay(20);
    yield chunk;
  }
}

async function readFixture(path: string, maxAudioMs: number): Promise<AudioFixture> {
  const source = await readPcm16Wav(path);
  const pcm =
    source.format.sampleRateHz === PCM16_16K_MONO.sampleRateHz
      ? source.bytes
      : resamplePcm16le(source.bytes, source.format.sampleRateHz, PCM16_16K_MONO.sampleRateHz);
  const maxBytes = Math.floor((PCM16_16K_MONO.sampleRateHz * maxAudioMs) / 1_000) * 2;
  const capped = pcm.slice(0, Math.min(pcm.byteLength, maxBytes) & ~1);
  return {
    pcm: capped,
    wav: pcmWav(capped, PCM16_16K_MONO),
    stereoWav: pcmWav(toStereo(capped), {
      sampleRateHz: 16_000,
      channels: 2,
      encoding: "pcm_s16le",
    }),
  };
}

function toStereo(mono: Uint8Array): Uint8Array {
  const stereo = new Uint8Array(mono.byteLength * 2);
  for (let offset = 0; offset < mono.byteLength; offset += 2) {
    stereo.set(mono.subarray(offset, offset + 2), offset * 2);
    stereo.set(mono.subarray(offset, offset + 2), offset * 2 + 2);
  }
  return stereo;
}

function pcmWav(audio: Uint8Array, format: AudioFormat): Uint8Array {
  const blockAlign = format.channels * 2;
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
  view.setUint32(28, format.sampleRateHz * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, audio.byteLength, true);
  output.set(audio, 44);
  return output;
}

function appendSilence(audio: Uint8Array, durationMs: number): Uint8Array {
  const silence = new Uint8Array(Math.floor((16_000 * durationMs) / 1_000) * 2);
  const output = new Uint8Array(audio.byteLength + silence.byteLength);
  output.set(audio);
  return output;
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

function assertTranscript(text: string, operation: string): void {
  if (text.trim().length === 0) throw new Error(`${operation} returned an empty transcript`);
}

async function runCase(name: string, operation: () => Promise<string>): Promise<SmokeResult> {
  const startedAt = Date.now();
  try {
    const detail = await operation();
    const result = {
      name,
      status: "passed" as const,
      detail: `${detail}; ${Date.now() - startedAt}ms`,
    };
    console.log(`[assemblyai] ${result.name}: ${result.status} (${result.detail})`);
    return result;
  } catch (error) {
    const result = {
      name,
      status: (isBlockedError(error) ? "blocked" : "failed") as SmokeStatus,
      detail: `${describeError(error)}; ${Date.now() - startedAt}ms`,
    };
    console.log(`[assemblyai] ${result.name}: ${result.status} (${result.detail})`);
    return result;
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required env var ${name}`);
  return value;
}

function isBlockedError(error: unknown): boolean {
  const value = describeError(error).toLowerCase();
  return [
    "auth_failed",
    "rate_limited",
    "quota",
    "credit",
    "balance",
    "unauthorized",
    "forbidden",
    "permission",
    "access denied",
    "insufficient",
  ].some((needle) => value.includes(needle));
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

function readPositiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
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
