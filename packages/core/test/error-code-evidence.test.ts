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
  it("[1.1.0:error-code:packages/core/src/errors.ts:295:10]", async () => {
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

  it("[1.1.0:error-code:packages/core/src/errors.ts:365:15]", async () => {
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

  it("[1.1.0:error-code:packages/core/src/errors.ts:390:15]", async () => {
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

  it("[1.1.0:error-code:packages/core/src/errors.ts:403:15]", async () => {
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

  it("[1.1.0:error-code:packages/core/src/errors.ts:416:15]", async () => {
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

  it("[1.1.0:error-code:packages/core/src/errors.ts:429:15]", async () => {
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

  it("[1.1.0:error-code:packages/core/src/errors.ts:442:15]", async () => {
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

  it("[1.1.0:error-code:packages/core/src/errors.ts:455:15]", async () => {
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

  it("[1.1.0:error-code:packages/core/src/errors.ts:468:15]", async () => {
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

  it("[1.1.0:error-code:packages/core/src/errors.ts:481:15]", async () => {
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

  it("[1.1.0:error-code:packages/core/src/errors.ts:494:15]", async () => {
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

  it("[1.1.0:error-code:packages/core/src/errors.ts:507:15]", async () => {
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

  it("[1.1.0:error-code:packages/core/src/errors.ts:581:21]", async () => {
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
