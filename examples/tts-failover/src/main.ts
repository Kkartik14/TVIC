import {
  createDeepgramSttProvider,
  createElevenLabsTtsHttpStreamProvider,
  createGroqChatLlmProvider,
  createSarvamTtsHttpStreamProvider,
  createWebClientAudioProvider,
  PCM16_16K_MONO,
} from "voice-runtime";

import { createFailoverVoiceAgent } from "./agent.js";
import { loadLocalEnv } from "./env.js";

loadLocalEnv();

const sarvamVoice = process.env.SARVAM_TTS_VOICE_ID ?? "shubh";
const sarvamLanguage = process.env.SARVAM_TTS_LANGUAGE ?? "en-IN";
const elevenLabsVoice = required("ELEVENLABS_VOICE_ID");
const elevenLabsModel = process.env.ELEVENLABS_TTS_MODEL ?? "eleven_flash_v2_5";

const agent = createFailoverVoiceAgent({
  id: "sarvam-elevenlabs-failover-agent",
  name: "Sarvam primary with ElevenLabs fallback",
  prompt: "You are a concise customer-support voice agent.",
  providers: {
    telephony: createWebClientAudioProvider(),
    stt: createDeepgramSttProvider({ apiKey: required("DEEPGRAM_API_KEY") }),
    llm: createGroqChatLlmProvider({
      apiKey: required("GROQ_API_KEY"),
      ...(process.env.GROQ_MODEL ? { model: process.env.GROQ_MODEL } : {}),
    }),
  },
  primaryTts: createSarvamTtsHttpStreamProvider({
    apiKey: required("SARVAM_API_KEY"),
    voiceId: sarvamVoice,
    language: sarvamLanguage,
  }),
  fallbackTts: createElevenLabsTtsHttpStreamProvider({
    apiKey: required("ELEVENLABS_API_KEY"),
    voiceId: elevenLabsVoice,
    modelId: elevenLabsModel,
  }),
  primaryTtsModel: "bulbul:v3",
  primaryTtsVoice: sarvamVoice,
  fallbackTtsModel: elevenLabsModel,
  fallbackTtsVoice: elevenLabsVoice,
  models: { llm: process.env.GROQ_MODEL ?? "openai/gpt-oss-20b" },
  audio: { input: PCM16_16K_MONO, output: PCM16_16K_MONO },
  onFallback: ({ phase, error, primary, fallback }) => {
    console.warn(
      `[tts-fallback] ${primary.name} -> ${fallback.name} phase=${phase} code=${error.code}`,
    );
  },
});

console.log(`created ${agent.name} with tts=${agent.providers.tts}`);
console.log("Attach this agent to your web-client call handler with agent.start(...).");

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required env var ${name}`);
  return value;
}
