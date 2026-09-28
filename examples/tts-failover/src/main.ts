import {
  createElevenLabsTtsHttpStreamProvider,
  createSarvamTtsHttpStreamProvider,
  PCM16_16K_MONO,
  type TextToSpeechProvider,
} from "voice-runtime";

import { createFailoverVoiceAgent } from "./agent.js";
import {
  createLocalFailingTts,
  createLocalFallbackTts,
  createLocalLlm,
  createLocalStt,
  createLocalTelephony,
  createScriptedCall,
  runOneTurn,
} from "./local-voice.js";
import { loadLocalEnv } from "./env.js";

loadLocalEnv();

const mode = process.env.VOICE_PROVIDER_MODE === "live" ? "live" : "mock";
const forcePrimaryFailure = process.env.FAILOVER_FORCE_PRIMARY_FAILURE === "1";

async function main(): Promise<void> {
  const stt = createLocalStt();
  const scriptedCall = createScriptedCall();
  const fallbackPhases: string[] = [];
  const tts = mode === "live" ? createLiveTts() : createMockTts();
  const agent = createFailoverVoiceAgent({
    id: "sarvam-elevenlabs-failover-agent",
    name: "Sarvam primary with ElevenLabs fallback",
    prompt: "You are a concise customer-support voice agent.",
    providers: {
      telephony: createLocalTelephony(),
      stt: stt.provider,
      llm: createLocalLlm(),
    },
    primaryTts: tts.primary,
    fallbackTts: tts.fallback,
    primaryTtsModel: tts.primaryModel,
    primaryTtsVoice: tts.primaryVoice,
    fallbackTtsModel: tts.fallbackModel,
    fallbackTtsVoice: tts.fallbackVoice,
    models: { llm: "local-scripted-llm" },
    audio: { input: PCM16_16K_MONO, output: PCM16_16K_MONO },
    onFallback: ({ phase, error, primary, fallback }) => {
      fallbackPhases.push(phase);
      console.log(
        `[fallback] ${primary.name} -> ${fallback.name} phase=${phase} code=${error.code}`,
      );
    },
  });

  try {
    const result = await runOneTurn(agent, stt, scriptedCall);
    console.log(`mode=${mode} agent=${agent.name}`);
    console.log(`turns=${result.turnsHandled} audio_chunks=${result.audioChunks}`);
    console.log(`fallback_phases=${fallbackPhases.join(",") || "none"}`);
    if (mode === "mock" && fallbackPhases.join(",") !== "synthesize") {
      throw new Error("mock mode did not exercise the expected TTS fallback");
    }
    if (mode === "live" && forcePrimaryFailure && fallbackPhases.join(",") !== "synthesize") {
      throw new Error("forced live failure did not exercise the expected TTS fallback");
    }
  } finally {
    await agent.stop();
  }
}

function createMockTts(): TtsConfiguration {
  return {
    primary: createLocalFailingTts(),
    fallback: createLocalFallbackTts(),
    primaryModel: "bulbul:v3",
    primaryVoice: "shubh",
    fallbackModel: "eleven_flash_v2_5",
    fallbackVoice: "local-elevenlabs-voice",
  };
}

function createLiveTts(): TtsConfiguration {
  const sarvamVoice = process.env.SARVAM_TTS_VOICE_ID ?? "shubh";
  const elevenLabsVoice = required("ELEVENLABS_VOICE_ID");
  const elevenLabsModel = process.env.ELEVENLABS_TTS_MODEL ?? "eleven_flash_v2_5";
  return {
    primary: createSarvamTtsHttpStreamProvider({
      apiKey: required("SARVAM_API_KEY"),
      voiceId: sarvamVoice,
      language: process.env.SARVAM_TTS_LANGUAGE ?? "en-IN",
      ...(forcePrimaryFailure ? { url: "http://127.0.0.1:1/fail" } : {}),
    }),
    fallback: createElevenLabsTtsHttpStreamProvider({
      apiKey: required("ELEVENLABS_API_KEY"),
      voiceId: elevenLabsVoice,
      modelId: elevenLabsModel,
    }),
    primaryModel: "bulbul:v3",
    primaryVoice: sarvamVoice,
    fallbackModel: elevenLabsModel,
    fallbackVoice: elevenLabsVoice,
  };
}

interface TtsConfiguration {
  readonly primary: TextToSpeechProvider;
  readonly fallback: TextToSpeechProvider;
  readonly primaryModel: string;
  readonly primaryVoice: string;
  readonly fallbackModel: string;
  readonly fallbackVoice: string;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required env var ${name}`);
  return value;
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
