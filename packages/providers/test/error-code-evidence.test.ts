import { describe, expect, it } from "vitest";

import { assemblyAiCloseError, assemblyAiProtocolError } from "../src/assemblyai-stt-protocol.js";
import { assemblyAiHttpError } from "../src/assemblyai-http-stt.js";
import { normalizeProviderError, providerError } from "../src/common.js";
import { deepgramCloseError, deepgramProtocolError } from "../src/deepgram.js";
import { elevenLabsBatchHttpError } from "../src/elevenlabs-batch-stt.js";
import { elevenLabsCloseError, elevenLabsProtocolError } from "../src/elevenlabs-stt-protocol.js";
import { classifiedProviderError } from "../src/provider-error-classifier.js";
import { sarvamProtocolError } from "../src/sarvam.js";
import {
  normalizeSarvamTtsConnectionError,
  sarvamTtsCloseError,
  sarvamTtsProtocolError,
} from "../src/sarvam-tts.js";
import { sonioxCloseError, sonioxProtocolError } from "../src/soniox-stt.js";

type Evidence = {
  readonly exercise: () => unknown | Promise<unknown>;
  readonly expected: {
    readonly code: string;
    readonly retriable: boolean;
  };
};

async function assertErrorMigrationEvidence({ exercise, expected }: Evidence): Promise<unknown> {
  const actual = await exercise();
  expect(actual).toMatchObject({ code: expected.code, retriable: expected.retriable });
  return actual;
}

describe("1.1.0 provider error-code migration evidence", () => {
  it("[1.1.0:error-code:packages/providers/src/assemblyai-stt-protocol.ts:161:10]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () => assemblyAiCloseError(1006),
      expected: {
        code: "stt.transport.unexpected_eof",
        retriable: true,
      },
    });
  });

  it("[1.1.0:error-code:packages/providers/src/assemblyai-stt-protocol.ts:195:10]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () => assemblyAiProtocolError({ type: "Error", code: 1011, message: "offline" }),
      expected: {
        code: "provider.upstream_failed",
        retriable: true,
      },
    });
  });

  it("[1.1.2:error-code:packages/providers/src/assemblyai-http-stt.ts:524:5]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () => assemblyAiHttpError(429, "", "poll"),
      expected: {
        code: "provider.rate_limited",
        retriable: true,
      },
    });
  });

  it("[1.1.0:error-code:packages/providers/src/common.ts:63:10]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () => providerError("provider.upstream_failed", "evidence"),
      expected: {
        code: "provider.upstream_failed",
        retriable: true,
      },
    });
  });

  it("[1.1.0:error-code:packages/providers/src/common.ts:495:5]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () =>
        normalizeProviderError(new Error("evidence"), {
          code: "provider.upstream_failed",
          provider: "evidence",
          retriable: false,
        }),
      expected: {
        code: "provider.upstream_failed",
        retriable: false,
      },
    });
  });

  it("[1.1.0:error-code:packages/providers/src/deepgram.ts:678:10]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () => deepgramCloseError(1006),
      expected: {
        code: "stt.transport.unexpected_eof",
        retriable: true,
      },
    });
  });

  it("[1.1.0:error-code:packages/providers/src/deepgram.ts:701:10]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () => deepgramProtocolError({ err_code: "DATA-0000" }, false),
      expected: {
        code: "provider.input_rejected",
        retriable: false,
      },
    });
  });

  it("[1.1.0:error-code:packages/providers/src/elevenlabs-stt-protocol.ts:144:10]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () => elevenLabsCloseError(1006),
      expected: {
        code: "stt.transport.unexpected_eof",
        retriable: true,
      },
    });
  });

  it("[1.1.0:error-code:packages/providers/src/elevenlabs-stt-protocol.ts:175:10]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () => elevenLabsProtocolError({ message_type: "input_error" }),
      expected: {
        code: "provider.input_rejected",
        retriable: false,
      },
    });
  });

  it("[1.1.0:error-code:packages/providers/src/sarvam.ts:560:10]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () => sarvamProtocolError("request_invalid", "invalid request"),
      expected: {
        code: "provider.invalid_request",
        retriable: false,
      },
    });
  });

  it("[1.1.0:error-code:packages/providers/src/sarvam-tts-protocol.ts:16:17]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () => sarvamTtsCloseError(1006),
      expected: {
        code: "provider.upstream_failed",
        retriable: true,
      },
    });
  });

  it("[1.1.0:error-code:packages/providers/src/sarvam-tts.ts:848:12]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () =>
        normalizeSarvamTtsConnectionError(new Error("Unexpected server response: 429")),
      expected: {
        code: "provider.rate_limited",
        retriable: true,
      },
    });
  });

  it("[1.1.0:error-code:packages/providers/src/sarvam-tts-protocol.ts:80:17]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () => sarvamTtsProtocolError(undefined, "invalid request"),
      expected: {
        code: "provider.invalid_request",
        retriable: false,
      },
    });
  });

  it("[1.1.0:error-code:packages/providers/src/elevenlabs-batch-stt.ts:465:5]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () => elevenLabsBatchHttpError(429, ""),
      expected: {
        code: "provider.rate_limited",
        retriable: true,
      },
    });
  });

  it("[1.1.0:error-code:packages/providers/src/soniox-stt.ts:846:10]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () => sonioxCloseError(1006),
      expected: {
        code: "stt.transport.unexpected_eof",
        retriable: true,
      },
    });
  });

  it("[1.1.0:error-code:packages/providers/src/soniox-stt.ts:880:10]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () => sonioxProtocolError({ error_type: "service_unavailable" }),
      expected: {
        code: "provider.upstream_failed",
        retriable: true,
      },
    });
  });

  it("[1.1.2:error-code:packages/providers/src/provider-error-classifier.ts:153:10]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () => {
        return classifiedProviderError("groq-chat-completions", "evidence", {
          providerCode: "insufficient_quota",
        });
      },
      expected: {
        code: "provider.quota_exceeded",
        retriable: false,
      },
    });
  });
});
