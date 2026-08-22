import {
  createAssemblyAiSttProvider,
  createDeepgramSttProvider,
  createElevenLabsSttProvider,
  createSarvamSttProvider,
  createSonioxSttProvider,
} from "@tvic/providers";
import { createSttSession } from "@tvic/runtime";
import { splitPcm16leFrames } from "@tvic/media";
import { PCM16_16K_MONO, type TranscriptEvent } from "@tvic/core";

import { readPcm16Wav } from "./wav.js";

const CHUNK_DURATION_MS = 20;
const TRANSCRIPT_FINALIZE_TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
  const inputPath = process.argv[2];
  if (!inputPath) {
    throw new Error(
      "Usage: STT_PROVIDER=deepgram|sarvam|elevenlabs|assemblyai|soniox pnpm --filter @tvic/example-stt-only start <file.wav>",
    );
  }

  const wav = await readPcm16Wav(inputPath);
  const provider = createSttProvider();
  const session = await createSttSession({
    provider,
    format: PCM16_16K_MONO,
    input: { format: wav.format, normalization: "auto" },
    ...(process.env.STT_MODEL ? { model: process.env.STT_MODEL } : {}),
    ...(process.env.STT_LANGUAGE ? { language: process.env.STT_LANGUAGE } : {}),
    interimResults: true,
  });

  let interrupted = false;
  const onInterrupt = (): void => {
    interrupted = true;
    void session.close().catch(() => undefined);
  };
  process.once("SIGINT", onInterrupt);

  let resolveEndpoint: () => void = () => undefined;
  const endpoint = new Promise<void>((resolve) => {
    resolveEndpoint = resolve;
  });
  const eventsDone = consumeEvents(session.events, () => resolveEndpoint());
  try {
    for (const chunk of splitPcm16leFrames(wav.bytes, wav.format, CHUNK_DURATION_MS)) {
      if (interrupted) {
        break;
      }
      try {
        await session.pushPcm16(chunk);
      } catch (error) {
        if (!interrupted) {
          throw error;
        }
        break;
      }
    }
    if (!interrupted) {
      await session.commit();
      await Promise.race([endpoint, delay(TRANSCRIPT_FINALIZE_TIMEOUT_MS)]);
    }
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    await session.close().catch(() => undefined);
  }
  await eventsDone;
}

function createSttProvider() {
  const providerName = process.env.STT_PROVIDER ?? "deepgram";
  if (providerName === "deepgram") {
    return createDeepgramSttProvider({ apiKey: requiredEnv("DEEPGRAM_API_KEY") });
  }
  if (providerName === "assemblyai") {
    return createAssemblyAiSttProvider({ apiKey: requiredEnv("ASSEMBLYAI_API_KEY") });
  }
  if (providerName === "sarvam") {
    return createSarvamSttProvider({ apiKey: requiredEnv("SARVAM_API_KEY") });
  }
  if (providerName === "elevenlabs") {
    return createElevenLabsSttProvider({ apiKey: requiredEnv("ELEVENLABS_API_KEY") });
  }
  if (providerName === "soniox") {
    return createSonioxSttProvider({ apiKey: requiredEnv("SONIOX_API_KEY") });
  }
  throw new Error(`Unsupported STT_PROVIDER: ${providerName}`);
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

async function consumeEvents(
  events: AsyncIterable<TranscriptEvent>,
  onEndpoint: () => void,
): Promise<void> {
  for await (const event of events) {
    if (event.type === "stt.partial" || event.type === "stt.final") {
      console.log(`[${event.type}] ${event.text}`);
    } else if (event.type === "stt.endpoint") {
      console.log("[stt.endpoint]");
      onEndpoint();
    } else if (event.type === "stt.speech.started") {
      console.log("[stt.speech.started]");
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
