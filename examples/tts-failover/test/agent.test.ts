import { describe, expect, it } from "vitest";

import { createFailoverVoiceAgent } from "../src/agent.js";
import {
  createLocalFailingTts,
  createLocalFallbackTts,
  createLocalLlm,
  createLocalStt,
  createLocalTelephony,
  createScriptedCall,
  runOneTurn,
} from "../src/local-voice.js";

describe("application TTS failover example", () => {
  it("runs a complete scripted turn through the fallback", async () => {
    const stt = createLocalStt();
    const scriptedCall = createScriptedCall();
    const fallbackPhases: string[] = [];
    const agent = createFailoverVoiceAgent({
      prompt: "Be helpful.",
      providers: {
        telephony: createLocalTelephony(),
        stt: stt.provider,
        llm: createLocalLlm(),
      },
      primaryTts: createLocalFailingTts(),
      fallbackTts: createLocalFallbackTts(),
      primaryTtsModel: "bulbul:v3",
      primaryTtsVoice: "shubh",
      fallbackTtsModel: "eleven_flash_v2_5",
      fallbackTtsVoice: "eleven-voice",
      onFallback: ({ phase }) => {
        fallbackPhases.push(phase);
      },
    });

    try {
      const result = await runOneTurn(agent, stt, scriptedCall);
      expect(result).toEqual({ turnsHandled: 1, audioChunks: 1 });
      expect(fallbackPhases).toEqual(["synthesize"]);
    } finally {
      await agent.stop();
    }
  });
});
