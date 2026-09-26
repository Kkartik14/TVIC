import { describe, expect, it } from "vitest";

import {
  createMediaEvent,
  nowTimestamp,
  PCM16_16K_MONO,
  providerError,
  TvicThrowableError,
  validationError,
  type ProviderCapabilities,
  type TextToSpeechProvider,
  type TtsEvent,
  type TtsStream,
  type TtsSynthesisRequest,
} from "@tvic/core";

import { createTtsFailoverProvider } from "../src/index.js";

const CAPABILITIES = {
  streaming: { input: false, output: true, native: true },
  cancellation: { request: true, output: true, buffer: false, truncation: false },
  transports: ["http"],
  audio: { output: [PCM16_16K_MONO] },
  models: ["primary-model"],
  voices: ["primary-voice"],
} satisfies ProviderCapabilities;

function request(): TtsSynthesisRequest {
  return {
    sessionId: "failover-session" as never,
    turnId: "failover-turn" as never,
    text: "Hello from the failover test.",
    model: "primary-model",
    voice: "primary-voice",
    format: PCM16_16K_MONO,
    stream: true,
  };
}

function provider(
  name: string,
  synthesize: TextToSpeechProvider["synthesize"],
): TextToSpeechProvider {
  return {
    name,
    kind: "tts",
    version: "test",
    capabilities: CAPABILITIES,
    synthesize,
  };
}

function audioEvent(requestValue: TtsSynthesisRequest): TtsEvent {
  return createMediaEvent({
    id: "failover-audio" as never,
    type: "media.audio.chunk",
    sessionId: requestValue.sessionId,
    turnId: requestValue.turnId,
    sequence: 1,
    direction: "output",
    timestamp: nowTimestamp(),
    monotonicOffsetMs: 0,
    provider: "fallback-tts",
    audio: {
      format: PCM16_16K_MONO,
      durationMs: 20,
      frameCount: 320,
      bytes: new Uint8Array(640),
    },
  });
}

function streamFrom(
  values: readonly TtsEvent[],
  failure?: unknown,
  onCancel?: () => void,
): TtsStream {
  return {
    events: {
      async *[Symbol.asyncIterator]() {
        for (const value of values) yield value;
        if (failure !== undefined) throw failure;
      },
    },
    async cancel() {
      onCancel?.();
    },
  };
}

async function collect(stream: TtsStream): Promise<TtsEvent[]> {
  const events: TtsEvent[] = [];
  for await (const event of stream.events) events.push(event);
  return events;
}

describe("explicit TTS failover provider", () => {
  it("maps Sarvam's request to ElevenLabs after a primary startup failure", async () => {
    const primaryError = TvicThrowableError.from(
      providerError("provider.upstream_failed", "Sarvam is unavailable", {
        provider: "sarvam-tts",
      }),
    );
    const calls: TtsSynthesisRequest[] = [];
    const fallbackContexts: string[] = [];
    const primary = provider("sarvam-tts", async () => {
      throw primaryError;
    });
    const fallback = provider("elevenlabs", async (value) => {
      calls.push(value);
      return streamFrom([]);
    });
    const failover = createTtsFailoverProvider({
      primary,
      fallback,
      mapFallbackRequest: (value) => ({
        ...value,
        model: "eleven_flash_v2_5",
        voice: "eleven-voice",
      }),
      onFallback: ({ phase, error }) => {
        fallbackContexts.push(`${phase}:${error.code}`);
      },
    });

    await collect(await failover.synthesize(request()));

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      sessionId: "failover-session",
      turnId: "failover-turn",
      model: "eleven_flash_v2_5",
      voice: "eleven-voice",
    });
    expect(fallbackContexts).toEqual(["synthesize:provider.upstream_failed"]);
  });

  it("fails over a stream that dies before emitting audio", async () => {
    let primaryCancelled = false;
    let fallbackCalls = 0;
    const primary = provider("sarvam-tts", async () =>
      streamFrom(
        [],
        TvicThrowableError.from(
          providerError("provider.sarvam.tts.error", "socket closed", {
            provider: "sarvam-tts",
          }),
        ),
        () => {
          primaryCancelled = true;
        },
      ),
    );
    const fallback = provider("elevenlabs", async () => {
      fallbackCalls += 1;
      return streamFrom([]);
    });
    const failover = createTtsFailoverProvider({ primary, fallback });

    await collect(await failover.synthesize(request()));

    expect(primaryCancelled).toBe(true);
    expect(fallbackCalls).toBe(1);
  });

  it("does not replay a turn after audio has already been delivered", async () => {
    let fallbackCalls = 0;
    const primary = provider("sarvam-tts", async (value) =>
      streamFrom(
        [audioEvent(value)],
        TvicThrowableError.from(
          providerError("provider.sarvam.tts.error", "socket closed after audio", {
            provider: "sarvam-tts",
          }),
        ),
      ),
    );
    const fallback = provider("elevenlabs", async () => {
      fallbackCalls += 1;
      return streamFrom([]);
    });
    const failover = createTtsFailoverProvider({ primary, fallback });

    await expect(collect(await failover.synthesize(request()))).rejects.toMatchObject({
      code: "provider.sarvam.tts.error",
    });
    expect(fallbackCalls).toBe(0);
  });

  it("does not hide invalid requests or caller cancellation", async () => {
    const invalidPrimary = provider("sarvam-tts", async () => {
      throw TvicThrowableError.from(
        validationError("provider.invalid_request", "Sarvam rejected the request"),
      );
    });
    const cancelledPrimary = provider("sarvam-tts", async () => {
      throw TvicThrowableError.from(
        providerError("provider.connection_cancelled", "request cancelled", {
          provider: "sarvam-tts",
          retriable: false,
        }),
      );
    });
    let fallbackCalls = 0;
    const fallback = provider("elevenlabs", async () => {
      fallbackCalls += 1;
      return streamFrom([]);
    });

    await expect(
      Promise.resolve().then(async () =>
        collect(
          await createTtsFailoverProvider({
            primary: invalidPrimary,
            fallback,
          }).synthesize(request()),
        ),
      ),
    ).rejects.toMatchObject({ code: "provider.invalid_request" });

    const controller = new AbortController();
    controller.abort();
    await expect(
      Promise.resolve().then(() =>
        createTtsFailoverProvider({ primary: cancelledPrimary, fallback }).synthesize({
          ...request(),
          signal: controller.signal,
        }),
      ),
    ).rejects.toMatchObject({ code: "provider.connection_cancelled" });

    expect(fallbackCalls).toBe(0);
  });

  it("keeps the provider output contract compatible", () => {
    const primary = provider("sarvam-tts", async () => streamFrom([]));
    const fallback = provider("elevenlabs", async () => streamFrom([]));
    const failover = createTtsFailoverProvider({ primary, fallback });

    expect(failover.kind).toBe("tts");
    expect(failover.capabilities.audio?.output).toEqual([PCM16_16K_MONO]);
    expect(failover.capabilities.metadata).toMatchObject({
      failover: { primary: "sarvam-tts", fallback: "elevenlabs" },
    });
  });

  it("supports an explicit policy override for provider-specific failures", async () => {
    const primary = provider("sarvam-tts", async () => {
      throw TvicThrowableError.from(
        validationError("provider.invalid_request", "known provider-specific constraint"),
      );
    });
    let fallbackCalls = 0;
    const fallback = provider("elevenlabs", async () => {
      fallbackCalls += 1;
      return streamFrom([]);
    });

    await collect(
      await createTtsFailoverProvider({
        primary,
        fallback,
        shouldFallback: () => true,
      }).synthesize(request()),
    );

    expect(fallbackCalls).toBe(1);
  });

  it("does not accept a mapper that changes runtime identity or format", async () => {
    const primary = provider("sarvam-tts", async () => {
      throw TvicThrowableError.from(
        providerError("provider.upstream_failed", "unavailable", { provider: "sarvam-tts" }),
      );
    });
    const fallback = provider("elevenlabs", async () => streamFrom([]));
    const failover = createTtsFailoverProvider({
      primary,
      fallback,
      mapFallbackRequest: (value) => ({ ...value, sessionId: "wrong-session" as never }),
    });

    await expect(failover.synthesize(request())).rejects.toThrow(
      "TTS failover request mapping may change only provider-specific fields",
    );
  });
});
