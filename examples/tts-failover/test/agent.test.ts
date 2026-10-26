import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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
  it("runs the actual main entry point with its default mock configuration", () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/main.ts"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: {
        ...process.env,
        VOICE_PROVIDER_MODE: "mock",
        FAILOVER_FORCE_PRIMARY_FAILURE: "0",
      },
      encoding: "utf8",
      timeout: 10_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("fallback_phases=synthesize");
    expect(result.stdout).toContain("audio_chunks=1");
  });

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

  it("keeps the forced-failure stub aligned with a configured V4 model and voice", async () => {
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
      primaryTts: createLocalFailingTts("bulbul:v4-flash", "simran_en_customer"),
      fallbackTts: createLocalFallbackTts(),
      primaryTtsModel: "bulbul:v4-flash",
      primaryTtsVoice: "simran_en_customer",
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
