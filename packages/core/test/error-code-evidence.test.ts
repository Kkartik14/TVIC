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
  it("[1.1.0:error-code:packages/core/src/errors.ts:385:10]", async () => {
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

  it("[1.1.0:error-code:packages/core/src/errors.ts:453:15]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () => providerError("provider.auth_failed", "evidence"),
      expected: {
        code: "provider.auth_failed",
        retriable: true,
      },
    });
  });

  it("[1.1.0:error-code:packages/core/src/errors.ts:466:15]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () => mediaError("provider.auth_failed", "evidence"),
      expected: {
        code: "provider.auth_failed",
        retriable: false,
      },
    });
  });

  it("[1.1.0:error-code:packages/core/src/errors.ts:478:15]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () => validationError("provider.auth_failed", "evidence"),
      expected: {
        code: "provider.auth_failed",
        retriable: false,
      },
    });
  });

  it("[1.1.0:error-code:packages/core/src/errors.ts:491:15]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () => timeoutError("provider.auth_failed", "evidence"),
      expected: {
        code: "provider.auth_failed",
        retriable: true,
      },
    });
  });

  it("[1.1.0:error-code:packages/core/src/errors.ts:504:15]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () => internalError("provider.auth_failed", "evidence"),
      expected: {
        code: "provider.auth_failed",
        retriable: false,
      },
    });
  });

  it("[1.1.0:error-code:packages/core/src/errors.ts:517:15]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () => authError("provider.auth_failed", "evidence"),
      expected: {
        code: "provider.auth_failed",
        retriable: false,
      },
    });
  });

  it("[1.1.0:error-code:packages/core/src/errors.ts:530:15]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () => rateLimitError("provider.auth_failed", "evidence"),
      expected: {
        code: "provider.auth_failed",
        retriable: true,
      },
    });
  });

  it("[1.1.0:error-code:packages/core/src/errors.ts:543:15]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () => connectionError("provider.auth_failed", "evidence"),
      expected: {
        code: "provider.auth_failed",
        retriable: true,
      },
    });
  });

  it("[1.1.0:error-code:packages/core/src/errors.ts:556:15]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () => signatureError("provider.auth_failed", "evidence"),
      expected: {
        code: "provider.auth_failed",
        retriable: false,
      },
    });
  });

  it("[1.1.0:error-code:packages/core/src/errors.ts:569:15]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () => cancelledError("provider.auth_failed", "evidence"),
      expected: {
        code: "provider.auth_failed",
        retriable: false,
      },
    });
  });

  it("[1.1.0:error-code:packages/core/src/errors.ts:582:15]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () => interruptedError("provider.auth_failed", "evidence"),
      expected: {
        code: "provider.auth_failed",
        retriable: false,
      },
    });
  });

  it("[1.1.0:error-code:packages/core/src/errors.ts:595:15]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () => toolError("provider.auth_failed", "evidence"),
      expected: {
        code: "provider.auth_failed",
        retriable: true,
      },
    });
  });

  it("[1.1.0:error-code:packages/core/src/errors.ts:609:10]", async () => {
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

  it("[1.1.2:error-code:packages/runtime/src/resilient-stt-policy.ts:184:10]", async () => {
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
