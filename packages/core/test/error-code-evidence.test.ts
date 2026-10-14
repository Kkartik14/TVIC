import { describe, expect, it } from "vitest";

import {
  authError,
  cancelledError,
  connectionError,
  internalError,
  interruptedError,
  mediaError,
  normalizedError,
  normalizedErrorFromErrorLike,
  normalizedErrorFromUnknown,
  providerError,
  rateLimitError,
  signatureError,
  timeoutError,
  toolError,
  validationError,
} from "../src/errors.js";

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

describe("1.1.0 error-code migration evidence", () => {
  it("[1.1.0:error-code:packages/core/src/errors.ts:355:10]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () =>
        normalizedErrorFromUnknown(new Error("evidence"), {
          code: "provider.auth_failed",
          retriable: false,
        }),
      expected: {
        code: "provider.auth_failed",
        retriable: false,
      },
    });
  });

  it("[1.1.0:error-code:packages/core/src/errors.ts:423:15]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () => providerError("provider.auth_failed", "evidence"),
      expected: {
        code: "provider.auth_failed",
        retriable: true,
      },
    });
  });

  it("[1.1.0:error-code:packages/core/src/errors.ts:436:15]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () => mediaError("provider.auth_failed", "evidence"),
      expected: {
        code: "provider.auth_failed",
        retriable: false,
      },
    });
  });

  it("[1.1.0:error-code:packages/core/src/errors.ts:448:15]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () => validationError("provider.auth_failed", "evidence"),
      expected: {
        code: "provider.auth_failed",
        retriable: false,
      },
    });
  });

  it("[1.1.0:error-code:packages/core/src/errors.ts:461:15]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () => timeoutError("provider.auth_failed", "evidence"),
      expected: {
        code: "provider.auth_failed",
        retriable: true,
      },
    });
  });

  it("[1.1.0:error-code:packages/core/src/errors.ts:474:15]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () => internalError("provider.auth_failed", "evidence"),
      expected: {
        code: "provider.auth_failed",
        retriable: false,
      },
    });
  });

  it("[1.1.0:error-code:packages/core/src/errors.ts:487:15]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () => authError("provider.auth_failed", "evidence"),
      expected: {
        code: "provider.auth_failed",
        retriable: false,
      },
    });
  });

  it("[1.1.0:error-code:packages/core/src/errors.ts:500:15]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () => rateLimitError("provider.auth_failed", "evidence"),
      expected: {
        code: "provider.auth_failed",
        retriable: true,
      },
    });
  });

  it("[1.1.0:error-code:packages/core/src/errors.ts:513:15]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () => connectionError("provider.auth_failed", "evidence"),
      expected: {
        code: "provider.auth_failed",
        retriable: true,
      },
    });
  });

  it("[1.1.0:error-code:packages/core/src/errors.ts:526:15]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () => signatureError("provider.auth_failed", "evidence"),
      expected: {
        code: "provider.auth_failed",
        retriable: false,
      },
    });
  });

  it("[1.1.0:error-code:packages/core/src/errors.ts:539:15]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () => cancelledError("provider.auth_failed", "evidence"),
      expected: {
        code: "provider.auth_failed",
        retriable: false,
      },
    });
  });

  it("[1.1.0:error-code:packages/core/src/errors.ts:552:15]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () => interruptedError("provider.auth_failed", "evidence"),
      expected: {
        code: "provider.auth_failed",
        retriable: false,
      },
    });
  });

  it("[1.1.0:error-code:packages/core/src/errors.ts:565:15]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () => toolError("provider.auth_failed", "evidence"),
      expected: {
        code: "provider.auth_failed",
        retriable: true,
      },
    });
  });

  it("[1.1.0:error-code:packages/core/src/errors.ts:579:10]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () => normalizedErrorFromErrorLike(new TypeError("evidence")),
      expected: {
        code: "error.type_error",
        retriable: false,
      },
    });
  });

  it("bounds error codes derived from Error names", () => {
    const error = new TypeError("evidence");
    error.name = "X".repeat(200);

    const normalized = normalizedErrorFromErrorLike(error);

    expect(normalized).toMatchObject({ code: "unknown.error", retriable: false });
    expect(normalized.code.length).toBeLessThanOrEqual(128);
    expect(() => normalizedError(`error.${"x".repeat(123)}`, "evidence")).toThrow(
      "128 UTF-8 bytes",
    );
  });

  it("[1.1.0:error-code:packages/runtime/src/resilient-stt-policy.ts:184:10]", async () => {
    const { audioWriteTimeoutError } = await import("../../runtime/src/resilient-stt-policy.js");
    await assertErrorMigrationEvidence({
      exercise: () => {
        const timedOut = audioWriteTimeoutError("stt.audio_write_timeout", "evidence", "deepgram");
        return timeoutError(timedOut.code, timedOut.message, {
          retriable: timedOut.retriable,
        });
      },
      expected: {
        code: "provider.transport_timeout",
        retriable: false,
      },
    });
  });
});
