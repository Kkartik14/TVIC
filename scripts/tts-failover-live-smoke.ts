import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  createElevenLabsTtsHttpStreamProvider,
  createSarvamTtsHttpStreamProvider,
  createTtsFailoverProvider,
  createVoiceAgent,
  PCM16_16K_MONO,
  type TtsEvent,
  type TtsSynthesisRequest,
} from "../packages/voice-runtime/dist/index.js";

loadLocalEnv();

const SESSION_ID = "tts_failover_live" as never;
const SARVAM_VOICE = process.env.SARVAM_TTS_VOICE_ID ?? "shubh";
const SARVAM_LANGUAGE = process.env.SARVAM_TTS_LANGUAGE ?? "en-IN";
const ELEVENLABS_VOICE = required("ELEVENLABS_VOICE_ID");
const ELEVENLABS_MODEL = process.env.ELEVENLABS_TTS_MODEL ?? "eleven_flash_v2_5";
const TEXT = "TVIC failover live test: the voice agent is speaking now.";

interface TtsSummary {
  readonly chunks: number;
  readonly bytes: number;
  readonly committed: number;
  readonly providers: readonly string[];
}

interface ConfiguredFailover {
  readonly tts: ReturnType<typeof createTtsFailoverProvider>;
  readonly fallbackPhases: string[];
}

void main().catch((error: unknown) => {
  console.error(describeError(error));
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const apiKey = required("SARVAM_API_KEY");
  const elevenApiKey = required("ELEVENLABS_API_KEY");

  const normal = configureFailover(apiKey, elevenApiKey);
  const normalSummary = await synthesize(normal.tts, "normal");
  if (!normalSummary.providers.includes("sarvam-tts")) {
    console.log(
      `normal primary was unavailable; observed failover phases=${normal.fallbackPhases.join(",")}`,
    );
  }

  // A loopback endpoint deterministically simulates a Sarvam outage without
  // sending a malformed request to the real service. ElevenLabs is still live.
  const forcedFailure = configureFailover(apiKey, elevenApiKey, "http://127.0.0.1:1/fail");
  const fallbackSummary = await synthesize(forcedFailure.tts, "forced-fallback");
  if (!fallbackSummary.providers.includes("elevenlabs")) {
    throw new Error(
      `forced failure did not use ElevenLabs: ${fallbackSummary.providers.join(", ")}`,
    );
  }
  if (forcedFailure.fallbackPhases.join(",") !== "synthesize") {
    throw new Error(`unexpected fallback phases: ${forcedFailure.fallbackPhases.join(",")}`);
  }

  // This is the actual managed-agent composition a user would pass to TVIC.
  // Construction validates the custom failover provider against the public
  // createVoiceAgent boundary; starting a call still requires a real handle.
  const agent = createVoiceAgent({
    prompt: "You are a concise support voice agent.",
    providers: {
      telephony: { provider: "web-client-audio" },
      stt: { provider: "deepgram", apiKey: required("DEEPGRAM_API_KEY") },
      llm: {
        provider: "groq",
        apiKey: required("GROQ_API_KEY"),
        model: process.env.GROQ_MODEL ?? "openai/gpt-oss-20b",
      },
      tts: normal.tts,
    },
    models: {
      tts: "bulbul:v3",
      ttsVoice: SARVAM_VOICE,
    },
  });
  await agent.stop();

  console.log(`normal: ${formatSummary(normalSummary)}`);
  console.log(`fallback: ${formatSummary(fallbackSummary)}`);
  console.log(`agent: constructed with tts=${agent.providers.tts}`);
}

function configureFailover(
  sarvamApiKey: string,
  elevenLabsApiKey: string,
  sarvamUrl?: string,
): ConfiguredFailover {
  const fallbackPhases: string[] = [];
  const sarvam = createSarvamTtsHttpStreamProvider({
    apiKey: sarvamApiKey,
    voiceId: SARVAM_VOICE,
    language: SARVAM_LANGUAGE,
    ...(sarvamUrl ? { url: sarvamUrl } : {}),
  });
  const elevenLabs = createElevenLabsTtsHttpStreamProvider({
    apiKey: elevenLabsApiKey,
    voiceId: ELEVENLABS_VOICE,
    modelId: ELEVENLABS_MODEL,
  });
  const tts = createTtsFailoverProvider({
    primary: sarvam,
    fallback: elevenLabs,
    mapFallbackRequest: (request) => ({
      ...request,
      model: ELEVENLABS_MODEL,
      voice: ELEVENLABS_VOICE,
    }),
    onFallback: ({ phase, error }) => {
      fallbackPhases.push(phase);
      console.log(`fallback selected phase=${phase} code=${error.code}`);
    },
  });
  return { tts, fallbackPhases };
}

async function synthesize(
  provider: ReturnType<typeof createTtsFailoverProvider>,
  turn: string,
): Promise<TtsSummary> {
  const request: TtsSynthesisRequest = {
    sessionId: SESSION_ID,
    turnId: `tts_${turn}` as never,
    text: TEXT,
    format: PCM16_16K_MONO,
    model: "bulbul:v3",
    voice: SARVAM_VOICE,
    stream: true,
  };
  const stream = await provider.synthesize(request);
  let chunks = 0;
  let bytes = 0;
  let committed = 0;
  const providers = new Set<string>();
  for await (const event of stream.events) {
    providers.add(event.provider);
    observeTtsEvent(
      event,
      (size) => {
        chunks += 1;
        bytes += size;
      },
      () => {
        committed += 1;
      },
    );
  }
  if (chunks === 0 || bytes === 0 || committed !== 1) {
    throw new Error(`invalid TTS output chunks=${chunks}, bytes=${bytes}, committed=${committed}`);
  }
  return { chunks, bytes, committed, providers: [...providers] };
}

function observeTtsEvent(
  event: TtsEvent,
  onAudio: (bytes: number) => void,
  onCommitted: () => void,
): void {
  if (event.type === "media.audio.chunk") onAudio(event.audio.bytes.byteLength);
  if (event.type === "media.audio.committed") onCommitted();
}

function formatSummary(summary: TtsSummary): string {
  return `providers=${summary.providers.join(",")}, chunks=${summary.chunks}, bytes=${summary.bytes}, committed=${summary.committed}`;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required env var ${name}`);
  return value;
}

function describeError(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const value = error as { readonly code?: unknown; readonly message?: unknown };
    if (typeof value.code === "string" && typeof value.message === "string") {
      return `${value.code}: ${value.message}`;
    }
  }
  return error instanceof Error ? error.message : String(error);
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
