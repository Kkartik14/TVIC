import {
  PCM16_16K_MONO,
  type LLMProvider,
  type ProviderCapabilities,
  type SpeechToTextProvider,
  type TelephonyProvider,
  type TextToSpeechProvider,
} from "voice-runtime";
import { describe, expect, it } from "vitest";

import { createFailoverVoiceAgent } from "../src/agent.js";

const capabilities = {
  streaming: { input: true, output: true, native: true },
  cancellation: { request: true, output: true, buffer: true, truncation: true },
  transports: ["websocket"],
  audio: { input: [PCM16_16K_MONO], output: [PCM16_16K_MONO] },
  tools: { functionCalling: true, parallelCalls: true },
  playout: { clearBuffer: true, acknowledgement: true, position: true },
} satisfies ProviderCapabilities;

describe("application TTS failover example", () => {
  it("passes the composed provider into the managed voice agent", () => {
    const agent = createFailoverVoiceAgent({
      prompt: "Be helpful.",
      providers: {
        telephony: fakeTelephony(),
        stt: fakeStt(),
        llm: fakeLlm(),
      },
      primaryTts: fakeTts("sarvam-tts"),
      fallbackTts: fakeTts("elevenlabs"),
      primaryTtsModel: "bulbul:v3",
      primaryTtsVoice: "shubh",
      fallbackTtsModel: "eleven_flash_v2_5",
      fallbackTtsVoice: "eleven-voice",
    });

    expect(agent.providers.tts).toBe("tts-failover:sarvam-tts->elevenlabs");
  });
});

function fakeTts(name: string): TextToSpeechProvider {
  return {
    name,
    kind: "tts",
    version: "test",
    capabilities,
    async synthesize() {
      return { events: emptyEvents(), async cancel() {} };
    },
  };
}

function fakeTelephony(): TelephonyProvider {
  return {
    name: "fake-telephony",
    kind: "telephony",
    version: "test",
    capabilities,
    async dial() {
      throw new Error("not used");
    },
    async accept() {
      throw new Error("not used");
    },
    async hangup() {},
  };
}

function fakeStt(): SpeechToTextProvider {
  return {
    name: "fake-stt",
    kind: "stt",
    version: "test",
    capabilities,
    async open() {
      return {
        events: emptyEvents(),
        async sendAudio() {},
        async commit() {},
        async close() {},
      };
    },
  };
}

function fakeLlm(): LLMProvider {
  return {
    name: "fake-llm",
    kind: "llm",
    version: "test",
    capabilities,
    async complete() {
      return { events: emptyEvents(), async cancel() {} };
    },
  };
}

async function* emptyEvents(): AsyncIterable<never> {}
