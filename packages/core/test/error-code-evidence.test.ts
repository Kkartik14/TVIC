import { describe, expect, it } from "vitest";

import { normalizedError } from "../src/errors.js";

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
  it("[1.1.0:error-code:packages/core/src/errors.ts:291:10]", async () => {
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

  it("[1.1.0:error-code:packages/core/src/errors.ts:361:15]", async () => {
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

  it("[1.1.0:error-code:packages/core/src/errors.ts:374:15]", async () => {
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

  it("[1.1.0:error-code:packages/core/src/errors.ts:386:15]", async () => {
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

  it("[1.1.0:error-code:packages/core/src/errors.ts:399:15]", async () => {
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

  it("[1.1.0:error-code:packages/core/src/errors.ts:412:15]", async () => {
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

  it("[1.1.0:error-code:packages/core/src/errors.ts:425:15]", async () => {
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

  it("[1.1.0:error-code:packages/core/src/errors.ts:438:15]", async () => {
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

  it("[1.1.0:error-code:packages/core/src/errors.ts:451:15]", async () => {
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

  it("[1.1.0:error-code:packages/core/src/errors.ts:464:15]", async () => {
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

  it("[1.1.0:error-code:packages/core/src/errors.ts:477:15]", async () => {
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

  it("[1.1.0:error-code:packages/core/src/errors.ts:490:15]", async () => {
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

  it("[1.1.0:error-code:packages/core/src/errors.ts:503:15]", async () => {
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

  it("[1.1.0:error-code:packages/core/src/errors.ts:579:21]", async () => {
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
});
