import {
  authError,
  cancelledError,
  connectionError,
  internalError,
  interruptedError,
  mediaError,
  normalizedErrorFromUnknown,
  normalizedError,
  providerError,
  rateLimitError,
  signatureError,
  timeoutError,
  toolError,
  validationError,
} from "../src/errors.ts";
import { normalizeProviderError } from "../../providers/src/common.ts";
import { audioWriteTimeoutError } from "../../runtime/src/resilient-stt-policy.ts";

export const evidenceSourceBindings = [
  {
    file: "packages/core/src/errors.ts",
    factories: ["normalizedError"],
  },
  {
    file: "packages/providers/src/common.ts",
    factories: ["normalizeUnknownError"],
  },
  {
    file: "packages/runtime/src/resilient-stt-policy.ts",
    factories: ["timeoutError"],
  },
];

export async function runErrorMigrationEvidence({
  recordFactoryCall,
  assertErrorMigrationEvidence,
}) {
  const rows = [];

  const expectedPassthrough = {
    code: "provider.auth_failed",
    retriable: false,
    retryOwner: "factory-declared",
    persistedReadPolicy: "accept only a manifest code; unknown persisted code is never retriable",
  };
  const observed290 = await recordFactoryCall(
    "packages/core/test/error-code-evidence.test.ts#normalizedErrorFromUnknown",
    "normalizedError",
    () => normalizedErrorFromUnknown(new Error("evidence"), { code: "provider.auth_failed" }),
  );
  const checked290 = await assertErrorMigrationEvidence({
    evidenceKey: "packages/core/test/error-code-evidence.test.ts#normalizedErrorFromUnknown",
    factory: "normalizedError",
    exercise: () => observed290,
    expected: expectedPassthrough,
  });
  rows.push({
    evidenceKey: "packages/core/test/error-code-evidence.test.ts#normalizedErrorFromUnknown",
    factory: "normalizedError",
    observed: checked290,
  });

  const expectedProvider = {
    code: "provider.auth_failed",
    retriable: true,
    retryOwner: "factory-declared",
    persistedReadPolicy: "accept only a manifest code; unknown persisted code is never retriable",
  };
  const observed360 = await recordFactoryCall(
    "packages/core/test/error-code-evidence.test.ts#providerError",
    "normalizedError",
    () => providerError("provider.auth_failed", "evidence"),
  );
  const checked360 = await assertErrorMigrationEvidence({
    evidenceKey: "packages/core/test/error-code-evidence.test.ts#providerError",
    factory: "normalizedError",
    exercise: () => observed360,
    expected: expectedProvider,
  });
  rows.push({
    evidenceKey: "packages/core/test/error-code-evidence.test.ts#providerError",
    factory: "normalizedError",
    observed: checked360,
  });

  const expectedMedia = {
    code: "provider.auth_failed",
    retriable: false,
    retryOwner: "factory-declared",
    persistedReadPolicy: "accept only a manifest code; unknown persisted code is never retriable",
  };
  const observed373 = await recordFactoryCall(
    "packages/core/test/error-code-evidence.test.ts#mediaError",
    "normalizedError",
    () => mediaError("provider.auth_failed", "evidence"),
  );
  const checked373 = await assertErrorMigrationEvidence({
    evidenceKey: "packages/core/test/error-code-evidence.test.ts#mediaError",
    factory: "normalizedError",
    exercise: () => observed373,
    expected: expectedMedia,
  });
  rows.push({
    evidenceKey: "packages/core/test/error-code-evidence.test.ts#mediaError",
    factory: "normalizedError",
    observed: checked373,
  });

  const expectedValidation = {
    code: "provider.auth_failed",
    retriable: false,
    retryOwner: "factory-declared",
    persistedReadPolicy: "accept only a manifest code; unknown persisted code is never retriable",
  };
  const observed385 = await recordFactoryCall(
    "packages/core/test/error-code-evidence.test.ts#validationError",
    "normalizedError",
    () => validationError("provider.auth_failed", "evidence"),
  );
  const checked385 = await assertErrorMigrationEvidence({
    evidenceKey: "packages/core/test/error-code-evidence.test.ts#validationError",
    factory: "normalizedError",
    exercise: () => observed385,
    expected: expectedValidation,
  });
  rows.push({
    evidenceKey: "packages/core/test/error-code-evidence.test.ts#validationError",
    factory: "normalizedError",
    observed: checked385,
  });

  const expectedTimeout = {
    code: "provider.auth_failed",
    retriable: true,
    retryOwner: "factory-declared",
    persistedReadPolicy: "accept only a manifest code; unknown persisted code is never retriable",
  };
  const observed398 = await recordFactoryCall(
    "packages/core/test/error-code-evidence.test.ts#timeoutError",
    "normalizedError",
    () => timeoutError("provider.auth_failed", "evidence"),
  );
  const checked398 = await assertErrorMigrationEvidence({
    evidenceKey: "packages/core/test/error-code-evidence.test.ts#timeoutError",
    factory: "normalizedError",
    exercise: () => observed398,
    expected: expectedTimeout,
  });
  rows.push({
    evidenceKey: "packages/core/test/error-code-evidence.test.ts#timeoutError",
    factory: "normalizedError",
    observed: checked398,
  });

  const expectedInternal = {
    code: "provider.auth_failed",
    retriable: false,
    retryOwner: "factory-declared",
    persistedReadPolicy: "accept only a manifest code; unknown persisted code is never retriable",
  };
  const observed411 = await recordFactoryCall(
    "packages/core/test/error-code-evidence.test.ts#internalError",
    "normalizedError",
    () => internalError("provider.auth_failed", "evidence"),
  );
  const checked411 = await assertErrorMigrationEvidence({
    evidenceKey: "packages/core/test/error-code-evidence.test.ts#internalError",
    factory: "normalizedError",
    exercise: () => observed411,
    expected: expectedInternal,
  });
  rows.push({
    evidenceKey: "packages/core/test/error-code-evidence.test.ts#internalError",
    factory: "normalizedError",
    observed: checked411,
  });

  const expectedAuth = {
    code: "provider.auth_failed",
    retriable: false,
    retryOwner: "factory-declared",
    persistedReadPolicy: "accept only a manifest code; unknown persisted code is never retriable",
  };
  const observed424 = await recordFactoryCall(
    "packages/core/test/error-code-evidence.test.ts#authError",
    "normalizedError",
    () => authError("provider.auth_failed", "evidence"),
  );
  const checked424 = await assertErrorMigrationEvidence({
    evidenceKey: "packages/core/test/error-code-evidence.test.ts#authError",
    factory: "normalizedError",
    exercise: () => observed424,
    expected: expectedAuth,
  });
  rows.push({
    evidenceKey: "packages/core/test/error-code-evidence.test.ts#authError",
    factory: "normalizedError",
    observed: checked424,
  });

  const expectedRateLimit = {
    code: "provider.auth_failed",
    retriable: true,
    retryOwner: "factory-declared",
    persistedReadPolicy: "accept only a manifest code; unknown persisted code is never retriable",
  };
  const observed437 = await recordFactoryCall(
    "packages/core/test/error-code-evidence.test.ts#rateLimitError",
    "normalizedError",
    () => rateLimitError("provider.auth_failed", "evidence"),
  );
  const checked437 = await assertErrorMigrationEvidence({
    evidenceKey: "packages/core/test/error-code-evidence.test.ts#rateLimitError",
    factory: "normalizedError",
    exercise: () => observed437,
    expected: expectedRateLimit,
  });
  rows.push({
    evidenceKey: "packages/core/test/error-code-evidence.test.ts#rateLimitError",
    factory: "normalizedError",
    observed: checked437,
  });

  const expectedConnection = {
    code: "provider.auth_failed",
    retriable: true,
    retryOwner: "factory-declared",
    persistedReadPolicy: "accept only a manifest code; unknown persisted code is never retriable",
  };
  const observed450 = await recordFactoryCall(
    "packages/core/test/error-code-evidence.test.ts#connectionError",
    "normalizedError",
    () => connectionError("provider.auth_failed", "evidence"),
  );
  const checked450 = await assertErrorMigrationEvidence({
    evidenceKey: "packages/core/test/error-code-evidence.test.ts#connectionError",
    factory: "normalizedError",
    exercise: () => observed450,
    expected: expectedConnection,
  });
  rows.push({
    evidenceKey: "packages/core/test/error-code-evidence.test.ts#connectionError",
    factory: "normalizedError",
    observed: checked450,
  });

  const expectedSignature = {
    code: "provider.auth_failed",
    retriable: false,
    retryOwner: "factory-declared",
    persistedReadPolicy: "accept only a manifest code; unknown persisted code is never retriable",
  };
  const observed463 = await recordFactoryCall(
    "packages/core/test/error-code-evidence.test.ts#signatureError",
    "normalizedError",
    () => signatureError("provider.auth_failed", "evidence"),
  );
  const checked463 = await assertErrorMigrationEvidence({
    evidenceKey: "packages/core/test/error-code-evidence.test.ts#signatureError",
    factory: "normalizedError",
    exercise: () => observed463,
    expected: expectedSignature,
  });
  rows.push({
    evidenceKey: "packages/core/test/error-code-evidence.test.ts#signatureError",
    factory: "normalizedError",
    observed: checked463,
  });

  const expectedCancelled = {
    code: "provider.auth_failed",
    retriable: false,
    retryOwner: "factory-declared",
    persistedReadPolicy: "accept only a manifest code; unknown persisted code is never retriable",
  };
  const observed476 = await recordFactoryCall(
    "packages/core/test/error-code-evidence.test.ts#cancelledError",
    "normalizedError",
    () => cancelledError("provider.auth_failed", "evidence"),
  );
  const checked476 = await assertErrorMigrationEvidence({
    evidenceKey: "packages/core/test/error-code-evidence.test.ts#cancelledError",
    factory: "normalizedError",
    exercise: () => observed476,
    expected: expectedCancelled,
  });
  rows.push({
    evidenceKey: "packages/core/test/error-code-evidence.test.ts#cancelledError",
    factory: "normalizedError",
    observed: checked476,
  });

  const expectedInterrupted = {
    code: "provider.auth_failed",
    retriable: false,
    retryOwner: "factory-declared",
    persistedReadPolicy: "accept only a manifest code; unknown persisted code is never retriable",
  };
  const observed489 = await recordFactoryCall(
    "packages/core/test/error-code-evidence.test.ts#interruptedError",
    "normalizedError",
    () => interruptedError("provider.auth_failed", "evidence"),
  );
  const checked489 = await assertErrorMigrationEvidence({
    evidenceKey: "packages/core/test/error-code-evidence.test.ts#interruptedError",
    factory: "normalizedError",
    exercise: () => observed489,
    expected: expectedInterrupted,
  });
  rows.push({
    evidenceKey: "packages/core/test/error-code-evidence.test.ts#interruptedError",
    factory: "normalizedError",
    observed: checked489,
  });

  const expectedTool = {
    code: "provider.auth_failed",
    retriable: true,
    retryOwner: "factory-declared",
    persistedReadPolicy: "accept only a manifest code; unknown persisted code is never retriable",
  };
  const observed502 = await recordFactoryCall(
    "packages/core/test/error-code-evidence.test.ts#toolError",
    "normalizedError",
    () => toolError("provider.auth_failed", "evidence"),
  );
  const checked502 = await assertErrorMigrationEvidence({
    evidenceKey: "packages/core/test/error-code-evidence.test.ts#toolError",
    factory: "normalizedError",
    exercise: () => observed502,
    expected: expectedTool,
  });
  rows.push({
    evidenceKey: "packages/core/test/error-code-evidence.test.ts#toolError",
    factory: "normalizedError",
    observed: checked502,
  });

  const expectedProviderBoundary = {
    code: "provider.upstream_failed",
    retriable: false,
    retryOwner: "factory-declared",
    persistedReadPolicy: "accept only a manifest code; unknown persisted code is never retriable",
  };
  const observedProviderBoundary = await recordFactoryCall(
    "packages/providers/test/error-code-evidence.test.ts#normalizeProviderError",
    "normalizeUnknownError",
    () =>
      normalizeProviderError(new Error("evidence"), {
        code: "provider.upstream_failed",
        provider: "evidence",
      }),
  );
  const checkedProviderBoundary = await assertErrorMigrationEvidence({
    evidenceKey: "packages/providers/test/error-code-evidence.test.ts#normalizeProviderError",
    factory: "normalizeUnknownError",
    exercise: () => observedProviderBoundary,
    expected: expectedProviderBoundary,
  });
  rows.push({
    evidenceKey: "packages/providers/test/error-code-evidence.test.ts#normalizeProviderError",
    factory: "normalizeUnknownError",
    observed: checkedProviderBoundary,
  });

  const expectedTransportTimeout = {
    code: "provider.transport_timeout",
    retriable: false,
    retryOwner: "factory-declared",
    persistedReadPolicy: "accept only a manifest code; unknown persisted code is never retriable",
  };
  const observedTransportTimeout = await recordFactoryCall(
    "packages/core/test/error-code-evidence.test.ts#audioWriteTimeoutError",
    "timeoutError",
    () => audioWriteTimeoutError("stt.audio_write_timeout", "evidence", "deepgram"),
  );
  const checkedTransportTimeout = await assertErrorMigrationEvidence({
    evidenceKey: "packages/core/test/error-code-evidence.test.ts#audioWriteTimeoutError",
    factory: "timeoutError",
    exercise: () => observedTransportTimeout,
    expected: expectedTransportTimeout,
  });
  rows.push({
    evidenceKey: "packages/core/test/error-code-evidence.test.ts#audioWriteTimeoutError",
    factory: "timeoutError",
    observed: checkedTransportTimeout,
  });

  return rows;
}
