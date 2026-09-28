import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
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
  createCartesiaSttProvider,
  createCartesiaTtsProvider,
  createDeepgramSttProvider,
  createElevenLabsSttProvider,
  createElevenLabsTtsProvider,
  createGroqChatLlmProvider,
  createOpenAiResponsesLlmProvider,
  createSarvamSttProvider,
  createSarvamTtsProvider,
  createSonioxSttProvider,
  PROVIDER_CATALOG,
} from "../packages/providers/dist/index.js";
import { splitPcm16leFrames } from "../packages/media/dist/index.js";
import { createSttSession } from "../packages/runtime/dist/index.js";

import { readPcm16Wav } from "../examples/stt-only/src/wav.js";

const STT_NAMES = ["deepgram", "assemblyai", "sarvam", "elevenlabs", "soniox", "cartesia"] as const;
const TTS_NAMES = ["cartesia", "elevenlabs", "sarvam"] as const;
const LLM_NAMES = ["openai", "groq"] as const;
type SttName = (typeof STT_NAMES)[number];
type TtsName = (typeof TTS_NAMES)[number];
type LlmName = (typeof LLM_NAMES)[number];
type SmokeRole = "stt" | "llm" | "tts";
type SmokeStatus = "passed" | "blocked" | "failed";
type SmokeConfiguration = Readonly<Record<string, boolean | number | string>>;
type SmokeCaseDefinition = {
  readonly name: string;
  readonly role: SmokeRole;
  readonly provider: string;
  readonly model: string;
  readonly voice?: string;
  readonly configuration: SmokeConfiguration;
};
type SmokeResult = {
  readonly name: SmokeCaseDefinition["name"];
  readonly role: SmokeRole;
  readonly provider: SmokeCaseDefinition["provider"];
  readonly model: SmokeCaseDefinition["model"];
  readonly voice?: string;
  readonly configuration: SmokeConfiguration;
  readonly status: SmokeStatus;
  readonly durationMs: number;
  readonly detail: string;
  readonly errorCode?: string;
};
type SmokeEvidence = {
  readonly schemaVersion: 2;
  readonly recordedAt: string;
  readonly reference: string;
  readonly harness: "provider-live-smoke";
  readonly execution: "diagnostic-only";
  readonly outcome: SmokeStatus;
  readonly fixture: {
    readonly format: AudioFormat;
    readonly audioBytes: number;
    readonly durationMs: number;
  };
  readonly requestedProviders: {
    readonly stt: readonly string[];
    readonly llm: readonly string[];
    readonly tts: readonly string[];
  };
  readonly cases: readonly SmokeResult[];
  readonly limitations: readonly string[];
};

loadLocalEnv();

void main().catch((error: unknown) => {
  console.error(`Provider live smoke failed (${safeErrorDetail(error)})`);
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
  const requestedProviders = {
    stt: parseNames(process.env.LIVE_SMOKE_STT ?? "deepgram", STT_NAMES, "STT"),
    llm: parseNames(process.env.LIVE_SMOKE_LLM ?? "groq", LLM_NAMES, "LLM"),
    tts: parseNames(process.env.LIVE_SMOKE_TTS ?? "cartesia", TTS_NAMES, "TTS"),
  };

  console.log(`Live fixture loaded (${audio.byteLength} audio bytes)`);

  for (const name of requestedProviders.stt) {
    results.push(
      await runCase(sttCaseDefinition(name, wav.format), () => runStt(name, audio, wav.format)),
    );
  }
  for (const name of requestedProviders.llm) {
    results.push(await runCase(llmCaseDefinition(name), () => runLlm(name)));
  }
  for (const name of requestedProviders.tts) {
    results.push(await runCase(ttsCaseDefinition(name), () => runTts(name)));
  }

  console.log("\nLive provider summary:");
  for (const result of results) {
    console.log(`- ${result.name}: ${result.status} (${result.detail}, ${result.durationMs}ms)`);
  }

  const outcome = summarizeStatus(results);
  writeEvidence({
    schemaVersion: 2,
    recordedAt: new Date().toISOString(),
    reference: evidenceReference(),
    harness: "provider-live-smoke",
    execution: "diagnostic-only",
    outcome,
    fixture: {
      format: wav.format,
      audioBytes: audio.byteLength,
      durationMs: Math.round(
        (audio.byteLength * 1_000) / (wav.format.sampleRateHz * 2 * wav.format.channels),
      ),
    },
    requestedProviders,
    cases: results,
    limitations: liveSmokeLimitations(),
  });

  if (outcome === "failed" || (outcome === "blocked" && !allowBlocked())) {
    process.exitCode = 1;
  }
}

async function runCase(
  definition: SmokeCaseDefinition,
  operation: () => Promise<string>,
): Promise<SmokeResult> {
  const startedAt = Date.now();
  try {
    const detail = await withTimeout(
      operation(),
      readPositiveNumber("LIVE_SMOKE_TIMEOUT_MS", 45_000),
    );
    return { ...definition, status: "passed", durationMs: Date.now() - startedAt, detail };
  } catch (error) {
    const errorCode = safeErrorCode(error);
    return {
      ...definition,
      status: isBlockedError(error) ? "blocked" : "failed",
      durationMs: Date.now() - startedAt,
      detail: safeErrorDetail(error),
      ...(errorCode ? { errorCode } : {}),
    };
  }
}

async function runStt(name: SttName, audio: Uint8Array, inputFormat: AudioFormat): Promise<string> {
  const provider = createSttProvider(name);
  const model = configuredSttModel(name);
  const language = providerLanguage(name);
  const session = await createSttSession({
    provider,
    format: PCM16_16K_MONO,
    input: { format: inputFormat, normalization: "auto" },
    model,
    ...(language ? { language } : {}),
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
    await waitForActivity(activity, readPositiveNumber("LIVE_SMOKE_WAIT_MS", 30_000));
  } finally {
    await session.close();
  }
  await eventsDone;
  if (eventError) throw eventError;

  if (finals === 0 || text.trim().length === 0) {
    throw new Error(`no nonempty final transcript was emitted (endpoint=${endpoints})`);
  }
  return `partial=${partials}, final=${finals}, endpoint=${endpoints}`;
}

function createSttProvider(name: SttName): SpeechToTextProvider {
  const apiKey = requiredEnv(
    {
      deepgram: "DEEPGRAM_API_KEY",
      assemblyai: "ASSEMBLYAI_API_KEY",
      sarvam: "SARVAM_API_KEY",
      elevenlabs: "ELEVENLABS_API_KEY",
      soniox: "SONIOX_API_KEY",
      cartesia: "CARTESIA_API_KEY",
    }[name],
  );
  const url = optionalEnv(
    {
      deepgram: "DEEPGRAM_API_URL",
      assemblyai: "ASSEMBLYAI_API_URL",
      sarvam: "SARVAM_API_URL",
      elevenlabs: "ELEVENLABS_STT_API_URL",
      soniox: "SONIOX_API_URL",
      cartesia: "CARTESIA_STT_API_URL",
    }[name],
  );
  switch (name) {
    case "deepgram":
      return createDeepgramSttProvider({ apiKey, ...(url ? { url } : {}) });
    case "assemblyai":
      return createAssemblyAiSttProvider({ apiKey, ...(url ? { url } : {}) });
    case "sarvam":
      return createSarvamSttProvider({ apiKey, ...(url ? { url } : {}) });
    case "elevenlabs":
      return createElevenLabsSttProvider({ apiKey, ...(url ? { url } : {}) });
    case "soniox":
      return createSonioxSttProvider({ apiKey, ...(url ? { url } : {}) });
    case "cartesia":
      return createCartesiaSttProvider({
        apiKey,
        ...(url ? { url } : {}),
        mode: cartesiaSttMode(),
      });
  }
}

async function runLlm(name: LlmName): Promise<string> {
  const model = configuredLlmModel(name);
  const provider =
    name === "groq"
      ? createGroqChatLlmProvider({
          apiKey: requiredEnv("GROQ_API_KEY"),
          ...(optionalEnv("GROQ_API_URL") ? { url: optionalEnv("GROQ_API_URL") } : {}),
        })
      : createOpenAiResponsesLlmProvider({
          apiKey: requiredEnv("OPENAI_API_KEY"),
          ...(optionalEnv("OPENAI_RESPONSES_URL")
            ? { url: optionalEnv("OPENAI_RESPONSES_URL") }
            : {}),
        });
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
  return `tokens=${tokens}, visible_text=true`;
}

function observeLlmEvent(
  event: LlmStreamEvent,
  onToken: (text: string) => void,
  onCompleted: () => void,
): void {
  if (event.type === "llm.token") onToken(event.text);
  if (event.type === "llm.completed") onCompleted();
  if (event.type === "llm.failed") throw new Error(`llm_failed:${event.error.code}`);
}

async function runTts(name: TtsName): Promise<string> {
  const model = configuredTtsModel(name);
  const stream =
    name === "cartesia"
      ? createCartesiaTtsProvider({
          apiKey: requiredEnv("CARTESIA_API_KEY"),
          voiceId: requiredEnv("CARTESIA_VOICE_ID"),
          modelId: model,
          ...(optionalEnv("CARTESIA_API_URL") ? { url: optionalEnv("CARTESIA_API_URL") } : {}),
        }).synthesize({
          sessionId: "live_provider_smoke" as never,
          turnId: "live_tts_cartesia" as never,
          text: "TVIC live synthesis test.",
          model,
          format: PCM16_16K_MONO,
          stream: true,
        })
      : name === "elevenlabs"
        ? createElevenLabsTtsProvider({
            apiKey: requiredEnv("ELEVENLABS_API_KEY"),
            voiceId: requiredEnv("ELEVENLABS_VOICE_ID"),
            modelId: model,
            ...(optionalEnv("ELEVENLABS_TTS_API_URL")
              ? { url: optionalEnv("ELEVENLABS_TTS_API_URL") }
              : {}),
          }).synthesize({
            sessionId: "live_provider_smoke" as never,
            turnId: "live_tts_elevenlabs" as never,
            text: "TVIC live synthesis test.",
            model,
            format: PCM16_16K_MONO,
            stream: true,
          })
        : createSarvamTtsProvider({
            apiKey: requiredEnv("SARVAM_API_KEY"),
            modelId: model,
            ...(optionalEnv("SARVAM_TTS_API_URL")
              ? { url: optionalEnv("SARVAM_TTS_API_URL") }
              : {}),
            ...(process.env.SARVAM_TTS_VOICE ? { voiceId: process.env.SARVAM_TTS_VOICE } : {}),
            ...(process.env.SARVAM_TTS_LANGUAGE
              ? { language: process.env.SARVAM_TTS_LANGUAGE }
              : {}),
          }).synthesize({
            sessionId: "live_provider_smoke" as never,
            turnId: "live_tts_sarvam" as never,
            text: process.env.SARVAM_TTS_TEXT ?? "TVIC live synthesis test.",
            model,
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
  return `chunks=${chunks}, audio_bytes=${bytes}, committed=${committed}`;
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

function sttCaseDefinition(name: SttName, inputFormat: AudioFormat): SmokeCaseDefinition {
  const language = providerLanguage(name);
  return {
    name: `stt:${name}`,
    role: "stt",
    provider: name,
    model: configuredSttModel(name),
    configuration: {
      endpoint: endpointDescription(sttUrlEnv(name)),
      inputFormat: formatLabel(inputFormat),
      outputFormat: formatLabel(PCM16_16K_MONO),
      normalization: "auto",
      interimResults: true,
      ...(language ? { language } : { language: "adapter-default" }),
      ...(name === "cartesia" ? { mode: cartesiaSttMode() } : {}),
    },
  };
}

function llmCaseDefinition(name: LlmName): SmokeCaseDefinition {
  return {
    name: `llm:${name}`,
    role: "llm",
    provider: name,
    model: configuredLlmModel(name),
    configuration: {
      endpoint: endpointDescription(
        optionalEnv(name === "groq" ? "GROQ_API_URL" : "OPENAI_RESPONSES_URL"),
      ),
      stream: true,
      maxTokens: 256,
      fixture: "fixed-smoke-prompt; payload-omitted",
    },
  };
}

function ttsCaseDefinition(name: TtsName): SmokeCaseDefinition {
  const voiceEnv =
    name === "cartesia"
      ? "CARTESIA_VOICE_ID"
      : name === "sarvam"
        ? "SARVAM_TTS_VOICE"
        : "ELEVENLABS_VOICE_ID";
  const endpointEnv =
    name === "cartesia"
      ? "CARTESIA_API_URL"
      : name === "sarvam"
        ? "SARVAM_TTS_API_URL"
        : "ELEVENLABS_TTS_API_URL";
  return {
    name: `tts:${name}`,
    role: "tts",
    provider: name,
    model: configuredTtsModel(name),
    ...(optionalEnv(voiceEnv) ? { voice: optionalEnv(voiceEnv) } : {}),
    configuration: {
      endpoint: endpointDescription(optionalEnv(endpointEnv)),
      format: formatLabel(PCM16_16K_MONO),
      stream: true,
      fixture: "fixed-smoke-text; payload-omitted",
    },
  };
}

function sttModelEnv(name: SttName): string {
  return {
    deepgram: "DEEPGRAM_MODEL",
    assemblyai: "ASSEMBLYAI_MODEL",
    sarvam: "SARVAM_MODEL",
    elevenlabs: "ELEVENLABS_STT_MODEL",
    soniox: "SONIOX_MODEL",
    cartesia: "CARTESIA_STT_MODEL",
  }[name];
}

function sttUrlEnv(name: SttName): string | undefined {
  return optionalEnv(
    {
      deepgram: "DEEPGRAM_API_URL",
      assemblyai: "ASSEMBLYAI_API_URL",
      sarvam: "SARVAM_API_URL",
      elevenlabs: "ELEVENLABS_STT_API_URL",
      soniox: "SONIOX_API_URL",
      cartesia: "CARTESIA_STT_API_URL",
    }[name],
  );
}

function providerLanguage(name: SttName): string | undefined {
  const providerLanguageEnv = name === "sarvam" ? "SARVAM_LANGUAGE" : "STT_LANGUAGE";
  return optionalEnv(providerLanguageEnv);
}

function configuredSttModel(name: SttName): string {
  return configuredModel(
    sttModelEnv(name),
    "STT_MODEL",
    {
      deepgram: PROVIDER_CATALOG.deepgram.defaultModel,
      assemblyai: PROVIDER_CATALOG.assemblyai.defaultModel,
      sarvam: PROVIDER_CATALOG.sarvam.defaultModel,
      elevenlabs: PROVIDER_CATALOG.elevenlabsStt.defaultModel,
      soniox: PROVIDER_CATALOG.soniox.defaultModel,
      cartesia: PROVIDER_CATALOG.cartesiaStt.defaultModel,
    }[name],
  );
}

function cartesiaSttMode(): "manual" | "auto" {
  const value = optionalEnv("CARTESIA_STT_MODE") ?? "manual";
  if (value === "manual" || value === "auto") return value;
  throw new Error(`CARTESIA_STT_MODE must be manual or auto, received: ${value}`);
}

function configuredLlmModel(name: LlmName): string {
  const primaryEnv = name === "groq" ? "GROQ_MODEL" : "OPENAI_MODEL";
  const fallbackEnv = name === "groq" ? "LLM_MODEL" : undefined;
  const defaultModel =
    name === "groq"
      ? PROVIDER_CATALOG.groq.defaultModel
      : PROVIDER_CATALOG.openaiResponses.defaultModel;
  return configuredModel(primaryEnv, fallbackEnv, defaultModel);
}

function configuredTtsModel(name: TtsName): string {
  const primaryEnv =
    name === "cartesia"
      ? "CARTESIA_MODEL"
      : name === "sarvam"
        ? "SARVAM_TTS_MODEL"
        : "ELEVENLABS_TTS_MODEL";
  const defaultModel =
    name === "cartesia"
      ? PROVIDER_CATALOG.cartesia.defaultModel
      : name === "sarvam"
        ? PROVIDER_CATALOG.sarvamTts.defaultModel
        : PROVIDER_CATALOG.elevenlabs.defaultModel;
  return configuredModel(primaryEnv, "TTS_MODEL", defaultModel);
}

function configuredModel(
  primaryEnv: string,
  fallbackEnv: string | undefined,
  fallback: string,
): string {
  return (
    optionalEnv(primaryEnv) ?? (fallbackEnv ? optionalEnv(fallbackEnv) : undefined) ?? fallback
  );
}

function formatLabel(format: AudioFormat): string {
  return `${format.encoding}/${format.sampleRateHz}Hz/${format.channels}ch`;
}

function endpointDescription(value: string | undefined): string {
  if (!value) return "adapter-default";
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "custom-endpoint-invalid-url";
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required env var ${name}`);
  return value;
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function isBlockedError(error: unknown): boolean {
  const code = safeErrorCode(error);
  const message = errorMessage(error).toLowerCase();
  return (
    code === "provider.auth_failed" ||
    code === "provider.rate_limited" ||
    code === "provider.quota_exceeded" ||
    code === "openai.http_error" ||
    code === "groq.http_error" ||
    /missing required env var/u.test(message) ||
    message.includes("balance") ||
    message.includes("quota") ||
    message.includes("credit") ||
    message.includes("rate limit") ||
    message.includes("insufficient")
  );
}

function summarizeStatus(results: readonly SmokeResult[]): SmokeStatus {
  if (results.some((result) => result.status === "failed")) return "failed";
  if (results.some((result) => result.status === "blocked")) return "blocked";
  return "passed";
}

function allowBlocked(): boolean {
  return process.env.LIVE_SMOKE_ALLOW_BLOCKED === "1";
}

function evidenceReference(): string {
  return (
    optionalEnv("TVIC_EVIDENCE_REFERENCE") ??
    optionalEnv("GITHUB_SHA") ??
    optionalEnv("CI_COMMIT_SHA") ??
    "not-provided"
  );
}

function liveSmokeLimitations(): readonly string[] {
  return [
    "One bounded provider invocation is smoke evidence, not validated or stable evidence.",
    "Only counters, configuration labels, and safe error codes are persisted; payloads are omitted.",
    "This harness does not exercise inbound Twilio Media Streams.",
    ...(allowBlocked() ? ["Blocked cases were allowed by LIVE_SMOKE_ALLOW_BLOCKED=1."] : []),
    ...(optionalEnv("TVIC_EVIDENCE_LIMITATIONS")
      ? [optionalEnv("TVIC_EVIDENCE_LIMITATIONS")!]
      : []),
  ];
}

function writeEvidence(evidence: SmokeEvidence): void {
  const configuredPath = optionalEnv("LIVE_SMOKE_EVIDENCE_PATH");
  const path = resolve(
    process.cwd(),
    configuredPath ?? "local/release/1.1.0/provider-live-smoke.json",
  );
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function safeErrorCode(error: unknown): string | undefined {
  return errorObjectField(error, "code") ?? errorObjectField(error, "errorCode");
}

function safeErrorDetail(error: unknown): string {
  const code = safeErrorCode(error);
  if (code) return `error_code=${code}`;
  const message = errorMessage(error);
  const missing = /missing required env var(?: for [^:]+)?: ([A-Z][A-Z0-9_]*)/u.exec(message);
  if (missing) return `missing_env=${missing[1]}`;
  if (/timed out/u.test(message)) return "timed_out=true";
  return "error=smoke_failure";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "";
}

function errorObjectField(error: unknown, field: string): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const value = (error as Record<string, unknown>)[field];
  if (typeof value === "string") return value;
  const nested = (error as Record<string, unknown>).error;
  if (typeof nested === "object" && nested !== null) {
    const nestedValue = (nested as Record<string, unknown>)[field];
    return typeof nestedValue === "string" ? nestedValue : undefined;
  }
  return undefined;
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

async function waitForActivity(activity: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      activity,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
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
