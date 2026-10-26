import { describe, expect, it } from "vitest";

import { PCM16_16K_MONO } from "@tvic/core";
import { CartesiaTtsProvider } from "../src/cartesia.js";
import { ElevenLabsTtsProvider } from "../src/elevenlabs.js";
import {
  ElevenLabsTtsHttpStreamProvider,
  ElevenLabsTtsRestProvider,
} from "../src/elevenlabs-http.js";
import { SarvamTtsProvider } from "../src/sarvam-tts.js";
import { SarvamTtsHttpStreamProvider, SarvamTtsRestProvider } from "../src/sarvam-tts-http.js";

const request = {
  sessionId: "session_text_controls" as never,
  turnId: "turn_text_controls" as never,
  format: PCM16_16K_MONO,
  text: "Spell TVIC",
  textControls: [{ type: "spell", match: "TVIC" }],
  stream: true,
} as const;

describe("TTS adapters reject undeclared text controls before network access", () => {
  it("rejects malformed Unicode control literals before opening a Cartesia socket", async () => {
    let opened = false;
    const provider = new CartesiaTtsProvider({
      apiKey: "test",
      voiceId: "voice-1",
      webSocketFactory: () => {
        opened = true;
        throw new Error("socket factory must not run");
      },
    });

    await expect(
      provider.synthesize({
        ...request,
        textControls: [{ type: "spell", match: "\ud83d" }],
      }),
    ).rejects.toMatchObject({ category: "validation" });
    expect(opened).toBe(false);
  });

  it.each([
    [
      "ElevenLabs WebSocket",
      () =>
        new ElevenLabsTtsProvider({
          apiKey: "test",
          voiceId: "voice-1",
          webSocketFactory: () => {
            throw new Error("socket factory must not run");
          },
        }),
    ],
    [
      "Sarvam WebSocket",
      () =>
        new SarvamTtsProvider({
          apiKey: "test",
          webSocketFactory: () => {
            throw new Error("socket factory must not run");
          },
        }),
    ],
  ])("rejects %s controls before opening a socket", async (_name, createProvider) => {
    await expect(createProvider().synthesize(request)).rejects.toMatchObject({
      category: "validation",
      metadata: {
        issues: [
          {
            code: "tts_text_control.unsupported",
            requirement: "ttsTextControls",
          },
        ],
      },
    });
  });

  it.each([
    [
      "ElevenLabs REST",
      (fetchImpl: typeof fetch) =>
        new ElevenLabsTtsRestProvider({
          apiKey: "test",
          voiceId: "voice-1",
          fetchImpl,
        }),
    ],
    [
      "ElevenLabs HTTP stream",
      (fetchImpl: typeof fetch) =>
        new ElevenLabsTtsHttpStreamProvider({
          apiKey: "test",
          voiceId: "voice-1",
          fetchImpl,
        }),
    ],
    [
      "Sarvam REST",
      (fetchImpl: typeof fetch) =>
        new SarvamTtsRestProvider({
          apiKey: "test",
          fetchImpl,
        }),
    ],
    [
      "Sarvam HTTP stream",
      (fetchImpl: typeof fetch) =>
        new SarvamTtsHttpStreamProvider({
          apiKey: "test",
          fetchImpl,
        }),
    ],
  ])("rejects %s controls before fetching", async (_name, createProvider) => {
    let fetched = false;
    const fetchImpl: typeof fetch = async () => {
      fetched = true;
      throw new Error("fetch must not run");
    };

    await expect(createProvider(fetchImpl).synthesize(request)).rejects.toMatchObject({
      category: "validation",
      metadata: {
        issues: [
          {
            code: "tts_text_control.unsupported",
            requirement: "ttsTextControls",
          },
        ],
      },
    });
    expect(fetched).toBe(false);
  });
});
