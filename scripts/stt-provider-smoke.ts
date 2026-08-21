import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  PCM16_16K_MONO,
  type AudioFormat,
  type TranscriptEvent,
} from "../packages/core/dist/index.js";
import { splitPcm16leFrames } from "../packages/media/dist/index.js";
import {
  createAssemblyAiSttProvider,
  createDeepgramSttProvider,
  createElevenLabsSttProvider,
  createSarvamSttProvider,
  createSonioxSttProvider,
} from "../packages/providers/dist/index.js";
import { createSttSession } from "../packages/runtime/dist/index.js";

import { readPcm16Wav } from "../examples/stt-only/src/wav.js";

const PROVIDER_NAMES = ["deepgram", "sarvam", "elevenlabs", "assemblyai", "soniox"] as const;
type SmokeProviderName = (typeof PROVIDER_NAMES)[number];

const CHUNK_DURATION_MS = 20;
const DEFAULT_WAIT_MS = 10_000;
const DEFAULT_AUDIO_MS = 15_000;

interface SmokeSummary {
  readonly provider: SmokeProviderName;
  readonly partials: number;
  readonly finals: number;
  readonly endpoints: number;
  readonly speechStarted: number;
}

loadLocalEnv();

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const inputPath = process.argv[2];
  if (!inputPath) {
    throw new Error(
      "Usage: STT_SMOKE_PROVIDERS=deepgram,assemblyai pnpm stt:smoke -- ./speech.wav",
    );
  }

  const providers = parseProviders(process.env.STT_SMOKE_PROVIDERS ?? process.env.STT_PROVIDER);
  const wav = await readPcm16Wav(inputPath);
  const maxAudioMs = readPositiveNumber("STT_SMOKE_MAX_AUDIO_MS", DEFAULT_AUDIO_MS);
  const maxBytes = Math.min(
    wav.bytes.byteLength,
    Math.floor((wav.format.sampleRateHz * maxAudioMs) / 1000) * 2 * wav.format.channels,
  );
  const audio = wav.bytes.slice(0, maxBytes - (maxBytes % 2));

  console.log(`Smoke fixture: ${inputPath} (${audio.byteLength} audio bytes)`);
  console.log(`Providers: ${providers.join(", ")}`);

  const summaries: SmokeSummary[] = [];
  for (const providerName of providers) {
    summaries.push(await runProvider(providerName, audio, wav.format));
  }

  console.log("\nSmoke summary:");
  for (const summary of summaries) {
    console.log(
      `- ${summary.provider}: partial=${summary.partials} final=${summary.finals} ` +
        `endpoint=${summary.endpoints} speech_started=${summary.speechStarted}`,
    );
  }
}

async function runProvider(
  providerName: SmokeProviderName,
  audio: Uint8Array,
  inputFormat: AudioFormat,
): Promise<SmokeSummary> {
  const startedAt = Date.now();
  const provider = createProvider(providerName);
  const session = await createSttSession({
    provider,
    format: PCM16_16K_MONO,
    input: { format: inputFormat, normalization: "auto" },
    ...(process.env.STT_MODEL !== undefined ? { model: process.env.STT_MODEL } : {}),
    ...(process.env.STT_LANGUAGE !== undefined ? { language: process.env.STT_LANGUAGE } : {}),
    interimResults: true,
  });

  let partials = 0;
  let finals = 0;
  let endpoints = 0;
  let speechStarted = 0;
  let resolveActivity: (() => void) | undefined;
  const activity = new Promise<void>((resolve) => {
    resolveActivity = resolve;
  });

  const eventsDone = consumeEvents(providerName, session.events, (event) => {
    if (event.type === "stt.partial") partials += 1;
    if (event.type === "stt.final") finals += 1;
    if (event.type === "stt.endpoint") endpoints += 1;
    if (event.type === "stt.speech.started") speechStarted += 1;
    if (event.type === "stt.final" || event.type === "stt.endpoint") {
      resolveActivity?.();
      resolveActivity = undefined;
    }
  });

  try {
    for (const chunk of splitPcm16leFrames(audio, inputFormat, CHUNK_DURATION_MS)) {
      await session.pushPcm16(chunk);
    }
    const waitMs = readPositiveNumber("STT_SMOKE_WAIT_MS", DEFAULT_WAIT_MS);
    await withTimeout(session.commit(), waitMs);
    await Promise.race([activity, delay(waitMs)]);
  } finally {
    await session.close();
  }
  await eventsDone;

  if (finals === 0 && endpoints === 0) {
    throw new Error(`${providerName} smoke produced neither a final transcript nor an endpoint`);
  }
  console.log(
    `${providerName}: passed in ${Date.now() - startedAt}ms ` +
      `(partial=${partials}, final=${finals}, endpoint=${endpoints})`,
  );
  return { provider: providerName, partials, finals, endpoints, speechStarted };
}

function createProvider(providerName: SmokeProviderName) {
  const apiKey = requiredEnv(
    {
      deepgram: "DEEPGRAM_API_KEY",
      sarvam: "SARVAM_API_KEY",
      elevenlabs: "ELEVENLABS_API_KEY",
      assemblyai: "ASSEMBLYAI_API_KEY",
      soniox: "SONIOX_API_KEY",
    }[providerName],
  );
  switch (providerName) {
    case "deepgram":
      return createDeepgramSttProvider({ apiKey });
    case "sarvam":
      return createSarvamSttProvider({ apiKey });
    case "elevenlabs":
      return createElevenLabsSttProvider({ apiKey });
    case "assemblyai":
      return createAssemblyAiSttProvider({ apiKey });
    case "soniox":
      return createSonioxSttProvider({ apiKey });
  }
}

async function consumeEvents(
  providerName: SmokeProviderName,
  events: AsyncIterable<TranscriptEvent>,
  observe: (event: TranscriptEvent) => void,
): Promise<void> {
  for await (const event of events) {
    observe(event);
    if (event.type === "stt.partial" || event.type === "stt.final") {
      console.log(`[${providerName}] ${event.type}: ${event.text}`);
    } else if (event.type === "stt.endpoint" || event.type === "stt.speech.started") {
      console.log(`[${providerName}] ${event.type}`);
    }
  }
}

function parseProviders(value: string | undefined): SmokeProviderName[] {
  const names = (value ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (names.length === 0) {
    throw new Error(`Set STT_SMOKE_PROVIDERS to one or more of: ${PROVIDER_NAMES.join(", ")}`);
  }
  const invalid = names.filter((name) => !PROVIDER_NAMES.includes(name as SmokeProviderName));
  if (invalid.length > 0) {
    throw new Error(`Unsupported smoke provider(s): ${invalid.join(", ")}`);
  }
  return [...new Set(names)] as SmokeProviderName[];
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var for smoke test: ${name}`);
  }
  return value;
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
          () => reject(new Error(`Smoke operation timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    if (!match) continue;
    const name = match[1];
    const raw = match[2] ?? "";
    if (!name || process.env[name] !== undefined) continue;
    process.env[name] = parseEnvValue(raw);
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
