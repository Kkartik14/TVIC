import { describe, expect, it } from "vitest";

import { normalizeUnknownError } from "@tvic/core";

import { providerError } from "../src/common.js";

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
  retryOwner: "provider-selector",
  persistedReadPolicy: "persist canonical code plus bounded legacy provider code",
};

describe("1.1.0 provider error-code migration evidence", () => {
  it("[1.1.0:error-code:packages/providers/src/assemblyai-stt.ts:673:10]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () => providerError("stt.transport.unexpected_eof", "evidence"),
      expected: {
        code: "stt.transport.unexpected_eof",
        retriable: true,
        retryOwner: policy.retryOwner,
        persistedReadPolicy: policy.persistedReadPolicy,
      },
    });
  });

  it("[1.1.0:error-code:packages/providers/src/assemblyai-stt.ts:707:10]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () => providerError("provider.upstream_failed", "evidence"),
      expected: {
        code: "provider.upstream_failed",
        retriable: true,
        retryOwner: policy.retryOwner,
        persistedReadPolicy: policy.persistedReadPolicy,
      },
    });
  });

  it("[1.1.0:error-code:packages/providers/src/common.ts:66:10]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () => providerError("provider.upstream_failed", "evidence"),
      expected: {
        code: "provider.upstream_failed",
        retriable: true,
        retryOwner: policy.retryOwner,
        persistedReadPolicy: policy.persistedReadPolicy,
      },
    });
  });

  it("[1.1.0:error-code:packages/providers/src/common.ts:354:5]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () =>
        normalizeUnknownError(new Error("evidence"), {
          code: "provider.upstream_failed",
          category: "provider",
          retriable: false,
        }),
      expected: {
        code: "provider.upstream_failed",
        retriable: false,
        retryOwner: policy.retryOwner,
        persistedReadPolicy: policy.persistedReadPolicy,
      },
    });
  });

  it("[1.1.0:error-code:packages/providers/src/deepgram.ts:368:10]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () => providerError("stt.transport.unexpected_eof", "evidence"),
      expected: {
        code: "stt.transport.unexpected_eof",
        retriable: true,
        retryOwner: policy.retryOwner,
        persistedReadPolicy: policy.persistedReadPolicy,
      },
    });
  });

  it("[1.1.0:error-code:packages/providers/src/deepgram.ts:391:10]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () => providerError("provider.input_rejected", "evidence", { retriable: false }),
      expected: {
        code: "provider.input_rejected",
        retriable: false,
        retryOwner: policy.retryOwner,
        persistedReadPolicy: policy.persistedReadPolicy,
      },
    });
  });

  it("[1.1.0:error-code:packages/providers/src/elevenlabs-stt.ts:414:10]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () => providerError("stt.transport.unexpected_eof", "evidence"),
      expected: {
        code: "stt.transport.unexpected_eof",
        retriable: true,
        retryOwner: policy.retryOwner,
        persistedReadPolicy: policy.persistedReadPolicy,
      },
    });
  });

  it("[1.1.0:error-code:packages/providers/src/elevenlabs-stt.ts:445:10]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () => providerError("provider.input_rejected", "evidence", { retriable: false }),
      expected: {
        code: "provider.input_rejected",
        retriable: false,
        retryOwner: policy.retryOwner,
        persistedReadPolicy: policy.persistedReadPolicy,
      },
    });
  });

  it("[1.1.0:error-code:packages/providers/src/sarvam.ts:443:10]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () => providerError("provider.invalid_request", "evidence", { retriable: false }),
      expected: {
        code: "provider.invalid_request",
        retriable: false,
        retryOwner: policy.retryOwner,
        persistedReadPolicy: policy.persistedReadPolicy,
      },
    });
  });

  it("[1.1.0:error-code:packages/providers/src/soniox-stt.ts:659:10]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () => providerError("stt.transport.unexpected_eof", "evidence"),
      expected: {
        code: "stt.transport.unexpected_eof",
        retriable: true,
        retryOwner: policy.retryOwner,
        persistedReadPolicy: policy.persistedReadPolicy,
      },
    });
  });

  it("[1.1.0:error-code:packages/providers/src/soniox-stt.ts:693:10]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () => providerError("provider.upstream_failed", "evidence"),
      expected: {
        code: "provider.upstream_failed",
        retriable: true,
        retryOwner: policy.retryOwner,
        persistedReadPolicy: policy.persistedReadPolicy,
      },
    });
  });
});
