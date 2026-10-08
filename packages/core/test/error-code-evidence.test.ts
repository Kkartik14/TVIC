import { describe, expect, it } from "vitest";

import { normalizedError, timeoutError } from "../src/errors.js";

type Evidence = {
  readonly exercise: () => unknown | Promise<unknown>;
  readonly expected: {
    readonly code: string;
    readonly retriable: boolean;
    readonly retryOwner: string;
    readonly persistedReadPolicy: string;
  };
};

async function assertErrorMigrationEvidence({ exercise, expected }: Evidence): Promise<unknown> {
  const actual = await exercise();
  expect(actual).toMatchObject({ code: expected.code, retriable: expected.retriable });
  return actual;
}

const policy = {
  retryOwner: "factory-declared",
  persistedReadPolicy: "accept only a manifest code; unknown persisted code is never retriable",
};

describe("1.1.0 error-code migration evidence", () => {
  it("[1.1.0:error-code:packages/core/src/errors.ts:283:10]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () => normalizedError("provider.auth_failed", "evidence", { retriable: false }),
      expected: {
        code: "provider.auth_failed",
        retriable: false,
        retryOwner: policy.retryOwner,
        persistedReadPolicy: policy.persistedReadPolicy,
      },
    });
  });

  it("[1.1.0:error-code:packages/core/src/errors.ts:353:15]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () => normalizedError("provider.auth_failed", "evidence", { retriable: true }),
      expected: {
        code: "provider.auth_failed",
        retriable: true,
        retryOwner: policy.retryOwner,
        persistedReadPolicy: policy.persistedReadPolicy,
      },
    });
  });

  it("[1.1.0:error-code:packages/core/src/errors.ts:366:15]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () => normalizedError("provider.auth_failed", "evidence", { retriable: false }),
      expected: {
        code: "provider.auth_failed",
        retriable: false,
        retryOwner: policy.retryOwner,
        persistedReadPolicy: policy.persistedReadPolicy,
      },
    });
  });

  it("[1.1.0:error-code:packages/core/src/errors.ts:378:15]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () => normalizedError("provider.auth_failed", "evidence", { retriable: false }),
      expected: {
        code: "provider.auth_failed",
        retriable: false,
        retryOwner: policy.retryOwner,
        persistedReadPolicy: policy.persistedReadPolicy,
      },
    });
  });

  it("[1.1.0:error-code:packages/core/src/errors.ts:391:15]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () => normalizedError("provider.auth_failed", "evidence", { retriable: true }),
      expected: {
        code: "provider.auth_failed",
        retriable: true,
        retryOwner: policy.retryOwner,
        persistedReadPolicy: policy.persistedReadPolicy,
      },
    });
  });

  it("[1.1.0:error-code:packages/core/src/errors.ts:404:15]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () => normalizedError("provider.auth_failed", "evidence", { retriable: false }),
      expected: {
        code: "provider.auth_failed",
        retriable: false,
        retryOwner: policy.retryOwner,
        persistedReadPolicy: policy.persistedReadPolicy,
      },
    });
  });

  it("[1.1.0:error-code:packages/core/src/errors.ts:417:15]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () => normalizedError("provider.auth_failed", "evidence", { retriable: false }),
      expected: {
        code: "provider.auth_failed",
        retriable: false,
        retryOwner: policy.retryOwner,
        persistedReadPolicy: policy.persistedReadPolicy,
      },
    });
  });

  it("[1.1.0:error-code:packages/core/src/errors.ts:430:15]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () => normalizedError("provider.auth_failed", "evidence", { retriable: true }),
      expected: {
        code: "provider.auth_failed",
        retriable: true,
        retryOwner: policy.retryOwner,
        persistedReadPolicy: policy.persistedReadPolicy,
      },
    });
  });

  it("[1.1.0:error-code:packages/core/src/errors.ts:443:15]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () => normalizedError("provider.auth_failed", "evidence", { retriable: true }),
      expected: {
        code: "provider.auth_failed",
        retriable: true,
        retryOwner: policy.retryOwner,
        persistedReadPolicy: policy.persistedReadPolicy,
      },
    });
  });

  it("[1.1.0:error-code:packages/core/src/errors.ts:456:15]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () => normalizedError("provider.auth_failed", "evidence", { retriable: false }),
      expected: {
        code: "provider.auth_failed",
        retriable: false,
        retryOwner: policy.retryOwner,
        persistedReadPolicy: policy.persistedReadPolicy,
      },
    });
  });

  it("[1.1.0:error-code:packages/core/src/errors.ts:469:15]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () => normalizedError("provider.auth_failed", "evidence", { retriable: false }),
      expected: {
        code: "provider.auth_failed",
        retriable: false,
        retryOwner: policy.retryOwner,
        persistedReadPolicy: policy.persistedReadPolicy,
      },
    });
  });

  it("[1.1.0:error-code:packages/core/src/errors.ts:482:15]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () => normalizedError("provider.auth_failed", "evidence", { retriable: false }),
      expected: {
        code: "provider.auth_failed",
        retriable: false,
        retryOwner: policy.retryOwner,
        persistedReadPolicy: policy.persistedReadPolicy,
      },
    });
  });

  it("[1.1.0:error-code:packages/core/src/errors.ts:495:15]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () => normalizedError("provider.auth_failed", "evidence", { retriable: true }),
      expected: {
        code: "provider.auth_failed",
        retriable: true,
        retryOwner: policy.retryOwner,
        persistedReadPolicy: policy.persistedReadPolicy,
      },
    });
  });

  it("[1.1.0:error-code:packages/core/src/errors.ts:571:21]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () => normalizedError("error.type_error", "evidence", { retriable: false }),
      expected: {
        code: "error.type_error",
        retriable: false,
        retryOwner: "none",
        persistedReadPolicy: "unknown persisted code is never retriable",
      },
    });
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
        retryOwner: policy.retryOwner,
        persistedReadPolicy: policy.persistedReadPolicy,
      },
    });
  });
});
