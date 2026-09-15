import { describe, expect, it } from "vitest";

import { providerError, type NormalizedError } from "../src/index.js";

type ReviewedError = NormalizedError & {
  readonly retryOwner: string;
  readonly persistedReadPolicy: string;
};

type Evidence = {
  readonly exercise: () => ReviewedError | Promise<ReviewedError>;
  readonly expected: Pick<
    ReviewedError,
    "code" | "retriable" | "retryOwner" | "persistedReadPolicy"
  >;
};

async function assertErrorMigrationEvidence({
  exercise,
  expected,
}: Evidence): Promise<ReviewedError> {
  const actual = await exercise();
  expect(actual).toMatchObject(expected);
  return actual;
}

const retryOwner = "provider-selector";
const persistedReadPolicy =
  "persist canonical code; preserve bounded legacyCode; unknown persisted code is never retriable";

function reviewed(error: NormalizedError, readPolicy = persistedReadPolicy): ReviewedError {
  return {
    ...error,
    retryOwner: retryOwner,
    persistedReadPolicy: readPolicy,
  };
}

describe("1.1.0 canonical error-code migration evidence", () => {
  it("[1.1.0:canonical-error:provider.auth_failed]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () =>
        reviewed(
          providerError("provider.auth_failed", "canonical migration evidence", {
            retriable: false,
          }),
        ),
      expected: {
        code: "provider.auth_failed",
        retriable: false,
        retryOwner: retryOwner,
        persistedReadPolicy: persistedReadPolicy,
      },
    });
  });

  it("[1.1.0:canonical-error:provider.rate_limited]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () =>
        reviewed(
          providerError("provider.rate_limited", "canonical migration evidence", {
            retriable: true,
          }),
        ),
      expected: {
        code: "provider.rate_limited",
        retriable: true,
        retryOwner: retryOwner,
        persistedReadPolicy: persistedReadPolicy,
      },
    });
  });

  it("[1.1.0:canonical-error:provider.model_unsupported]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () =>
        reviewed(
          providerError("provider.model_unsupported", "canonical migration evidence", {
            retriable: false,
          }),
        ),
      expected: {
        code: "provider.model_unsupported",
        retriable: false,
        retryOwner: retryOwner,
        persistedReadPolicy: persistedReadPolicy,
      },
    });
  });

  it("[1.1.0:canonical-error:provider.voice_unsupported]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () =>
        reviewed(
          providerError("provider.voice_unsupported", "canonical migration evidence", {
            retriable: false,
          }),
        ),
      expected: {
        code: "provider.voice_unsupported",
        retriable: false,
        retryOwner: retryOwner,
        persistedReadPolicy: persistedReadPolicy,
      },
    });
  });

  it("[1.1.0:canonical-error:provider.input_rejected]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () =>
        reviewed(
          providerError("provider.input_rejected", "canonical migration evidence", {
            retriable: false,
          }),
        ),
      expected: {
        code: "provider.input_rejected",
        retriable: false,
        retryOwner: retryOwner,
        persistedReadPolicy: persistedReadPolicy,
      },
    });
  });

  it("[1.1.0:canonical-error:provider.invalid_request]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () =>
        reviewed(
          providerError("provider.invalid_request", "canonical migration evidence", {
            retriable: false,
          }),
        ),
      expected: {
        code: "provider.invalid_request",
        retriable: false,
        retryOwner: retryOwner,
        persistedReadPolicy: persistedReadPolicy,
      },
    });
  });

  it("[1.1.0:canonical-error:provider.session_expired]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () =>
        reviewed(
          providerError("provider.session_expired", "canonical migration evidence", {
            retriable: false,
          }),
        ),
      expected: {
        code: "provider.session_expired",
        retriable: false,
        retryOwner: retryOwner,
        persistedReadPolicy: persistedReadPolicy,
      },
    });
  });

  it("[1.1.0:canonical-error:provider.protocol_invalid]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () =>
        reviewed(
          providerError("provider.protocol_invalid", "canonical migration evidence", {
            retriable: false,
          }),
        ),
      expected: {
        code: "provider.protocol_invalid",
        retriable: false,
        retryOwner: retryOwner,
        persistedReadPolicy: persistedReadPolicy,
      },
    });
  });

  it("[1.1.0:canonical-error:provider.sequence_invalid]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () =>
        reviewed(
          providerError("provider.sequence_invalid", "canonical migration evidence", {
            retriable: false,
          }),
        ),
      expected: {
        code: "provider.sequence_invalid",
        retriable: false,
        retryOwner: retryOwner,
        persistedReadPolicy: persistedReadPolicy,
      },
    });
  });

  it("[1.1.0:canonical-error:provider.upstream_failed]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () =>
        reviewed(
          providerError("provider.upstream_failed", "canonical migration evidence", {
            retriable: true,
          }),
        ),
      expected: {
        code: "provider.upstream_failed",
        retriable: true,
        retryOwner: retryOwner,
        persistedReadPolicy: persistedReadPolicy,
      },
    });
  });

  it("[1.1.0:canonical-error:provider.identity_mismatch]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () =>
        reviewed(
          providerError("provider.identity_mismatch", "canonical migration evidence", {
            retriable: false,
          }),
        ),
      expected: {
        code: "provider.identity_mismatch",
        retriable: false,
        retryOwner: retryOwner,
        persistedReadPolicy: persistedReadPolicy,
      },
    });
  });

  it("[1.1.0:canonical-error:provider.stream_buffer_overflow]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () =>
        reviewed(
          providerError("provider.stream_buffer_overflow", "canonical migration evidence", {
            retriable: false,
          }),
        ),
      expected: {
        code: "provider.stream_buffer_overflow",
        retriable: false,
        retryOwner: retryOwner,
        persistedReadPolicy: persistedReadPolicy,
      },
    });
  });

  it("[1.1.0:canonical-error:stt.session_buffer_overflow]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () =>
        reviewed(
          providerError("stt.session_buffer_overflow", "canonical migration evidence", {
            retriable: false,
          }),
        ),
      expected: {
        code: "stt.session_buffer_overflow",
        retriable: false,
        retryOwner: retryOwner,
        persistedReadPolicy: persistedReadPolicy,
      },
    });
  });

  it("[1.1.0:canonical-error:stt.commit_in_flight]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () =>
        reviewed(
          providerError("stt.commit_in_flight", "canonical migration evidence", {
            retriable: false,
          }),
        ),
      expected: {
        code: "stt.commit_in_flight",
        retriable: false,
        retryOwner: retryOwner,
        persistedReadPolicy: persistedReadPolicy,
      },
    });
  });

  it("[1.1.0:canonical-error:llm.provider.failed]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () =>
        reviewed(
          providerError("llm.provider.failed", "canonical migration evidence", { retriable: true }),
        ),
      expected: {
        code: "llm.provider.failed",
        retriable: true,
        retryOwner: retryOwner,
        persistedReadPolicy: persistedReadPolicy,
      },
    });
  });

  it("[1.1.0:canonical-error:stt.transport.unexpected_eof]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () =>
        reviewed(
          providerError("stt.transport.unexpected_eof", "canonical migration evidence", {
            retriable: true,
          }),
          "accept-current-code; never use unknown persisted code for retry",
        ),
      expected: {
        code: "stt.transport.unexpected_eof",
        retriable: true,
        retryOwner: retryOwner,
        persistedReadPolicy: "accept-current-code; never use unknown persisted code for retry",
      },
    });
  });

  it("[1.1.0:canonical-error:tts.transport.unexpected_eof]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () =>
        reviewed(
          providerError("tts.transport.unexpected_eof", "canonical migration evidence", {
            retriable: true,
          }),
        ),
      expected: {
        code: "tts.transport.unexpected_eof",
        retriable: true,
        retryOwner: retryOwner,
        persistedReadPolicy: persistedReadPolicy,
      },
    });
  });

  it("[1.1.0:canonical-error:llm.provider.unexpected_eof]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () =>
        reviewed(
          providerError("llm.provider.unexpected_eof", "canonical migration evidence", {
            retriable: true,
          }),
        ),
      expected: {
        code: "llm.provider.unexpected_eof",
        retriable: true,
        retryOwner: retryOwner,
        persistedReadPolicy: persistedReadPolicy,
      },
    });
  });
});
