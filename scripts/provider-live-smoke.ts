import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  PCM16_16K_MONO,
  type AudioFormat,
  type LlmStreamEvent,
  type SpeechToTextProvider,
  type TranscriptEvent,
  type TtsEvent,
} from "../packages/core/dist/index.js";
import {
  createAssemblyAiSttProvider,
  createCartesiaTtsProvider,
  createDeepgramSttProvider,
  createElevenLabsSttProvider,
  createElevenLabsTtsProvider,
  createOpenAiResponsesLlmProvider,
  createSarvamSttProvider,
  createSonioxSttProvider,
} from "../packages/providers/dist/index.js";
import { splitPcm16leFrames } from "../packages/media/dist/index.js";
import { createSttSession } from "../packages/runtime/dist/index.js";

import { readPcm16Wav } from "../examples/stt-only/src/wav.js";

const STT_NAMES = ["deepgram", "assemblyai", "sarvam", "elevenlabs", "soniox"] as const;
const TTS_NAMES = ["cartesia", "elevenlabs"] as const;
const LLM_NAMES = ["openai", "groq"] as const;
type SttName = (typeof STT_NAMES)[number];
type TtsName = (typeof TTS_NAMES)[number];
type LlmName = (typeof LLM_NAMES)[number];
type SmokeResult = {
  readonly name: string;
  readonly status: "passed" | "blocked" | "failed";
  readonly detail: string;
};

loadLocalEnv();

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const inputPath = process.argv.slice(2).find((argument) => argument !== "--");
  if (!inputPath) {
    throw new Error(
      "Usage: pnpm providers:live-smoke -- ./speech.wav (build first with pnpm build)",
    );
  }

  const wav = await readPcm16Wav(inputPath);
  const maxAudioMs = readPositiveNumber("LIVE_SMOKE_MAX_AUDIO_MS", 8_000);
  const maxBytes = Math.min(
    wav.bytes.byteLength,
    Math.floor((wav.format.sampleRateHz * maxAudioMs) / 1_000) * 2 * wav.format.channels,
  );
  const audio = wav.bytes.slice(0, maxBytes - (maxBytes % 2));
  const results: SmokeResult[] = [];

  console.log(`Live fixture: ${inputPath} (${audio.byteLength} audio bytes)`);

  for (const name of parseNames(process.env.LIVE_SMOKE_STT, STT_NAMES, "STT")) {
    results.push(await runCase(`stt:${name}`, () => runStt(name, audio, wav.format)));
  }
  for (const name of parseNames(process.env.LIVE_SMOKE_LLM, LLM_NAMES, "LLM")) {
    results.push(await runCase(`llm:${name}`, () => runLlm(name)));
  }
  for (const name of parseNames(process.env.LIVE_SMOKE_TTS, TTS_NAMES, "TTS")) {
    results.push(await runCase(`tts:${name}`, () => runTts(name)));
  }

  console.log("\nLive provider summary:");
  for (const result of results) {
    console.log(`- ${result.name}: ${result.status} (${result.detail})`);
  }

  const failed = results.filter((result) => result.status === "failed");
  const blocked = results.filter((result) => result.status === "blocked");
  if (failed.length > 0 || (blocked.length > 0 && process.env.LIVE_SMOKE_ALLOW_BLOCKED !== "1")) {
    process.exitCode = 1;
  }
}

async function runCase(name: string, operation: () => Promise<string>): Promise<SmokeResult> {
  const startedAt = Date.now();
  try {
    const detail = await withTimeout(
      operation(),
      readPositiveNumber("LIVE_SMOKE_TIMEOUT_MS", 45_000),
    );
    return { name, status: "passed", detail: `${detail}; ${Date.now() - startedAt}ms` };
  } catch (error) {
    const detail = describeError(error);
    return {
      name,
      status: isBlockedError(error) ? "blocked" : "failed",
      detail: `${detail}; ${Date.now() - startedAt}ms`,
    };
  }
}

async function runStt(name: SttName, audio: Uint8Array, inputFormat: AudioFormat): Promise<string> {
  const provider = createSttProvider(name);
  const session = await createSttSession({
    provider,
    format: PCM16_16K_MONO,
    input: { format: inputFormat, normalization: "auto" },
    ...(name === "sarvam" ? { language: process.env.SARVAM_LANGUAGE ?? "en-IN" } : {}),
    interimResults: true,
  });

  let partials = 0;
  let finals = 0;
  let endpoints = 0;
  let text = "";
  let resolveActivity: (() => void) | undefined;
  const activity = new Promise<void>((resolve) => {
    resolveActivity = resolve;
  });
  let eventError: unknown;
  const eventsDone = consumeSttEvents(session.events, (event) => {
    if (event.type === "stt.partial") {
      partials += 1;
      text = event.text;
    }
    if (event.type === "stt.final") {
      finals += 1;
      text = event.text;
      resolveActivity?.();
      resolveActivity = undefined;
    }
    if (event.type === "stt.endpoint") {
      endpoints += 1;
    }
  }).catch((error: unknown) => {
    eventError = error;
  });

  try {
    for (const chunk of splitPcm16leFrames(audio, inputFormat, 20)) {
      await session.pushPcm16(chunk);
    }
    await withTimeout(session.commit(), readPositiveNumber("LIVE_SMOKE_WAIT_MS", 30_000));
    await Promise.race([activity, delay(readPositiveNumber("LIVE_SMOKE_WAIT_MS", 30_000))]);
  } finally {
    await session.close();
  }
  await eventsDone;
  if (eventError) throw eventError;

  if (finals === 0 || text.trim().length === 0) {
    throw new Error(`no nonempty final transcript was emitted (endpoint=${endpoints})`);
  }
  return `partial=${partials}, final=${finals}, endpoint=${endpoints}, text=${JSON.stringify(text.slice(0, 120))}`;
}

function createSttProvider(name: SttName): SpeechToTextProvider {
  const apiKey = requiredEnv(
    {
      deepgram: "DEEPGRAM_API_KEY",
      assemblyai: "ASSEMBLYAI_API_KEY",
      sarvam: "SARVAM_API_KEY",
      elevenlabs: "ELEVENLABS_API_KEY",
      soniox: "SONIOX_API_KEY",
    }[name],
  );
  switch (name) {
    case "deepgram":
      return createDeepgramSttProvider({ apiKey });
    case "assemblyai":
      return createAssemblyAiSttProvider({ apiKey });
    case "sarvam":
      return createSarvamSttProvider({ apiKey });
    case "elevenlabs":
      return createElevenLabsSttProvider({ apiKey });
    case "soniox":
      return createSonioxSttProvider({ apiKey });
  }
}

async function runLlm(name: LlmName): Promise<string> {
  const apiKey = requiredEnv(name === "groq" ? "GROQ_API_KEY" : "OPENAI_API_KEY");
  const provider = createOpenAiResponsesLlmProvider({
    apiKey,
    ...(name === "groq"
      ? { url: process.env.GROQ_RESPONSES_URL ?? "https://api.groq.com/openai/v1/responses" }
      : { url: process.env.OPENAI_RESPONSES_URL ?? "https://api.openai.com/v1/responses" }),
  });
  const model =
    name === "groq"
      ? (process.env.GROQ_MODEL ?? "openai/gpt-oss-20b")
      : (process.env.OPENAI_MODEL ?? "gpt-4.1-mini");
  const completion = await provider.complete({
    sessionId: "live_provider_smoke" as never,
    turnId: `live_${name}` as never,
    model,
    messages: [
      { role: "system", content: "Answer with exactly one short sentence." },
      { role: "user", content: "Reply with exactly: TVIC live test passed." },
    ],
    stream: true,
    maxTokens: 256,
  });

  let tokens = 0;
  let text = "";
  let completed = false;
  for await (const event of completion.events) {
    observeLlmEvent(
      event,
      (value) => {
        tokens += 1;
        text += value;
      },
      () => {
        completed = true;
      },
    );
  }
  if (!completed || text.trim().length === 0) {
    throw new Error(`stream ended without visible text (tokens=${tokens})`);
  }
  return `model=${model}, tokens=${tokens}, text=${JSON.stringify(text.slice(0, 120))}`;
}

function observeLlmEvent(
  event: LlmStreamEvent,
  onToken: (text: string) => void,
  onCompleted: () => void,
): void {
  if (event.type === "llm.token") onToken(event.text);
  if (event.type === "llm.completed") onCompleted();
  if (event.type === "llm.failed") throw new Error(`${event.error.code}: ${event.error.message}`);
}

async function runTts(name: TtsName): Promise<string> {
  const stream =
    name === "cartesia"
      ? createCartesiaTtsProvider({
          apiKey: requiredEnv("CARTESIA_API_KEY"),
          voiceId: requiredEnv("CARTESIA_VOICE_ID"),
          ...(process.env.CARTESIA_MODEL ? { modelId: process.env.CARTESIA_MODEL } : {}),
        }).synthesize({
          sessionId: "live_provider_smoke" as never,
          turnId: "live_tts_cartesia" as never,
          text: "TVIC live synthesis test.",
          format: PCM16_16K_MONO,
          stream: true,
        })
      : createElevenLabsTtsProvider({
          apiKey: requiredEnv("ELEVENLABS_API_KEY"),
          voiceId: requiredEnv("ELEVENLABS_VOICE_ID"),
          ...(process.env.ELEVENLABS_TTS_MODEL
            ? { modelId: process.env.ELEVENLABS_TTS_MODEL }
            : {}),
        }).synthesize({
          sessionId: "live_provider_smoke" as never,
          turnId: "live_tts_elevenlabs" as never,
          text: "TVIC live synthesis test.",
          format: PCM16_16K_MONO,
          stream: true,
        });
  const resolvedStream = await stream;
  let chunks = 0;
  let bytes = 0;
  let committed = 0;
  for await (const event of resolvedStream.events) {
    observeTtsEvent(
      event,
      (chunkBytes) => {
        chunks += 1;
        bytes += chunkBytes;
      },
      () => {
        committed += 1;
      },
    );
  }
  if (chunks === 0 || bytes === 0 || committed !== 1) {
    throw new Error(`invalid output chunks=${chunks}, bytes=${bytes}, committed=${committed}`);
  }
  return `chunks=${chunks}, bytes=${bytes}, committed=${committed}`;
}

function observeTtsEvent(
  event: TtsEvent,
  onAudio: (bytes: number) => void,
  onCommitted: () => void,
): void {
  if (event.type === "media.audio.chunk") onAudio(event.audio.bytes.byteLength);
  if (event.type === "media.audio.committed") onCommitted();
}

async function consumeSttEvents(
  events: AsyncIterable<TranscriptEvent>,
  observe: (event: TranscriptEvent) => void,
): Promise<void> {
  for await (const event of events) observe(event);
}

function parseNames<T extends readonly string[]>(
  value: string | undefined,
  allowed: T,
  category: string,
): T[number][] {
  const names = (value ?? allowed.join(","))
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const invalid = names.filter((name) => !allowed.includes(name as T[number]));
  if (invalid.length > 0) {
    throw new Error(`Unsupported ${category} live provider(s): ${invalid.join(", ")}`);
  }
  return [...new Set(names)] as T[number][];
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required env var ${name}`);
  return value;
}

function isBlockedError(error: unknown): boolean {
  const code = errorObjectField(error, "code");
  const message = describeError(error).toLowerCase();
  return (
    code === "stt.provider.quota_exceeded" ||
    code === "openai.http_error" ||
    message.includes("missing required env var") ||
    message.includes("balance") ||
    message.includes("quota") ||
    message.includes("credit") ||
    message.includes("rate limit") ||
    message.includes("insufficient")
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
  if (!Number.isFinite(value) || value <= 0)
    throw new Error(`${name} must be a positive finite number`);
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
