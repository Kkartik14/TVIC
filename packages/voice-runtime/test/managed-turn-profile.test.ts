import { describe, expect, it } from "vitest";

import {
  createVoiceAgent,
  type Call,
  type CallHandle,
  type LLMProvider,
  type ProviderCapabilities,
  type SpeechToTextProvider,
  type TelephonyProvider,
  type TextToSpeechProvider,
} from "../src/index.js";
import { nowTimestamp, PCM16_16K_MONO } from "@tvic/core";

const capabilities = {
  streaming: { input: true, output: true, native: true },
  cancellation: { request: true, output: false, buffer: false, truncation: false },
  transports: ["websocket"],
  audio: { input: [PCM16_16K_MONO], output: [PCM16_16K_MONO] },
  playout: { clearBuffer: true, acknowledgement: true, position: true },
  turnProfiles: [{ model: "universal-3-6-pro", profiles: ["latency", "balanced", "accuracy"] }],
} satisfies ProviderCapabilities;

describe("managed call-setting preflight", () => {
  it("rejects unmapped STT profiles and TTS controls before creating the managed session", async () => {
    let callHandleCreated = false;
    let sttOpened = false;
    const stt: SpeechToTextProvider = {
      name: "assemblyai-stt",
      kind: "stt",
      version: "1.0.0",
      capabilities,
      async open() {
        sttOpened = true;
        throw new Error("STT must not open");
      },
    };
    const llm: LLMProvider = {
      name: "test-llm",
      kind: "llm",
      version: "1.0.0",
      capabilities,
      async complete() {
        throw new Error("LLM must not run");
      },
    };
    const tts: TextToSpeechProvider = {
      name: "test-tts",
      kind: "tts",
      version: "1.0.0",
      capabilities,
      async synthesize() {
        throw new Error("TTS must not run");
      },
    };
    const telephony: TelephonyProvider = {
      name: "test-telephony",
      kind: "telephony",
      version: "1.0.0",
      capabilities,
      async dial() {
        throw new Error("dial must not run");
      },
      async accept() {
        throw new Error("accept must not run");
      },
      async hangup() {},
    };
    const callHandle: CallHandle = {
      callId: "profile-call" as never,
      events: { async *[Symbol.asyncIterator]() {} },
      async send() {
        return true;
      },
      async clear() {},
      async close() {},
    };
    const timestamp = nowTimestamp();
    const call: Call = {
      id: callHandle.callId,
      provider: "test-telephony",
      direction: "inbound",
      from: "caller",
      to: "agent",
      status: "connected",
      mediaTransport: { kind: "websocket", format: PCM16_16K_MONO },
      createdAt: timestamp,
      startedAt: timestamp,
    };
    const agent = createVoiceAgent({
      prompt: "Answer the caller.",
      models: { stt: "universal-3-5-pro" },
      providers: { telephony, stt, llm, tts },
    });

    try {
      const turnProfileError = await agent
        .start({
          call: call,
          callHandle: () => {
            callHandleCreated = true;
            return callHandle;
          },
          turnProfile: "latency",
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(
        (turnProfileError as { metadata?: { issues?: readonly unknown[] } }).metadata?.issues,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "turn_profile.unsupported", requirement: "turnProfile" }),
        ]),
      );

      const textControlError = await agent
        .start({
          call: call,
          callHandle: () => {
            callHandleCreated = true;
            return callHandle;
          },
          ttsTextControls: [{ type: "spell", match: "TVIC" }],
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(
        (textControlError as { metadata?: { issues?: readonly unknown[] } }).metadata?.issues,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "tts_text_control.unsupported",
            requirement: "ttsTextControls",
          }),
        ]),
      );
      expect(callHandleCreated).toBe(false);
      expect(sttOpened).toBe(false);
    } finally {
      await agent.stop();
    }
  });
});
