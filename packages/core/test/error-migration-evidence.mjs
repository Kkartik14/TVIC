import {
  authError,
  cancelledError,
  connectionError,
  internalError,
  interruptedError,
  mediaError,
  normalizeUnknownError,
  normalizedError,
  providerError,
  rateLimitError,
  signatureError,
  timeoutError,
  toolError,
  validationError,
} from "../src/errors.ts";
import { normalizeProviderError } from "../../providers/src/common.ts";

export const evidenceSourceBindings = [
  {
    file: "packages/core/src/errors.ts",
    factories: ["normalizedError"],
  },
  {
    file: "packages/providers/src/common.ts",
    factories: ["normalizeUnknownError"],
  },
];

function annotate(value, expected) {
  Object.assign(value, {
    retryOwner: expected.retryOwner,
    persistedReadPolicy: expected.persistedReadPolicy,
  });
  return value;
}

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
    "packages/core/src/errors.ts:295:10:normalizedError",
    "normalizedError",
    () => normalizeUnknownError(new Error("evidence"), { code: "provider.auth_failed" }),
  );
  annotate(observed290, expectedPassthrough);
  const checked290 = await assertErrorMigrationEvidence({
    sourceLocation: "packages/core/src/errors.ts:295:10:normalizedError",
    factory: "normalizedError",
    exercise: () => observed290,
    expected: expectedPassthrough,
  });
  rows.push({
    sourceLocation: "packages/core/src/errors.ts:295:10:normalizedError",
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
    "packages/core/src/errors.ts:365:15:normalizedError",
    "normalizedError",
    () => providerError("provider.auth_failed", "evidence"),
  );
  annotate(observed360, expectedProvider);
  const checked360 = await assertErrorMigrationEvidence({
    sourceLocation: "packages/core/src/errors.ts:365:15:normalizedError",
    factory: "normalizedError",
    exercise: () => observed360,
    expected: expectedProvider,
  });
  rows.push({
    sourceLocation: "packages/core/src/errors.ts:365:15:normalizedError",
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
    "packages/core/src/errors.ts:378:15:normalizedError",
    "normalizedError",
    () => mediaError("provider.auth_failed", "evidence"),
  );
  annotate(observed373, expectedMedia);
  const checked373 = await assertErrorMigrationEvidence({
    sourceLocation: "packages/core/src/errors.ts:378:15:normalizedError",
    factory: "normalizedError",
    exercise: () => observed373,
    expected: expectedMedia,
  });
  rows.push({
    sourceLocation: "packages/core/src/errors.ts:378:15:normalizedError",
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
    "packages/core/src/errors.ts:390:15:normalizedError",
    "normalizedError",
    () => validationError("provider.auth_failed", "evidence"),
  );
  annotate(observed385, expectedValidation);
  const checked385 = await assertErrorMigrationEvidence({
    sourceLocation: "packages/core/src/errors.ts:390:15:normalizedError",
    factory: "normalizedError",
    exercise: () => observed385,
    expected: expectedValidation,
  });
  rows.push({
    sourceLocation: "packages/core/src/errors.ts:390:15:normalizedError",
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
    "packages/core/src/errors.ts:403:15:normalizedError",
    "normalizedError",
    () => timeoutError("provider.auth_failed", "evidence"),
  );
  annotate(observed398, expectedTimeout);
  const checked398 = await assertErrorMigrationEvidence({
    sourceLocation: "packages/core/src/errors.ts:403:15:normalizedError",
    factory: "normalizedError",
    exercise: () => observed398,
    expected: expectedTimeout,
  });
  rows.push({
    sourceLocation: "packages/core/src/errors.ts:403:15:normalizedError",
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
    "packages/core/src/errors.ts:416:15:normalizedError",
    "normalizedError",
    () => internalError("provider.auth_failed", "evidence"),
  );
  annotate(observed411, expectedInternal);
  const checked411 = await assertErrorMigrationEvidence({
    sourceLocation: "packages/core/src/errors.ts:416:15:normalizedError",
    factory: "normalizedError",
    exercise: () => observed411,
    expected: expectedInternal,
  });
  rows.push({
    sourceLocation: "packages/core/src/errors.ts:416:15:normalizedError",
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
    "packages/core/src/errors.ts:429:15:normalizedError",
    "normalizedError",
    () => authError("provider.auth_failed", "evidence"),
  );
  annotate(observed424, expectedAuth);
  const checked424 = await assertErrorMigrationEvidence({
    sourceLocation: "packages/core/src/errors.ts:429:15:normalizedError",
    factory: "normalizedError",
    exercise: () => observed424,
    expected: expectedAuth,
  });
  rows.push({
    sourceLocation: "packages/core/src/errors.ts:429:15:normalizedError",
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
    "packages/core/src/errors.ts:442:15:normalizedError",
    "normalizedError",
    () => rateLimitError("provider.auth_failed", "evidence"),
  );
  annotate(observed437, expectedRateLimit);
  const checked437 = await assertErrorMigrationEvidence({
    sourceLocation: "packages/core/src/errors.ts:442:15:normalizedError",
    factory: "normalizedError",
    exercise: () => observed437,
    expected: expectedRateLimit,
  });
  rows.push({
    sourceLocation: "packages/core/src/errors.ts:442:15:normalizedError",
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
    "packages/core/src/errors.ts:455:15:normalizedError",
    "normalizedError",
    () => connectionError("provider.auth_failed", "evidence"),
  );
  annotate(observed450, expectedConnection);
  const checked450 = await assertErrorMigrationEvidence({
    sourceLocation: "packages/core/src/errors.ts:455:15:normalizedError",
    factory: "normalizedError",
    exercise: () => observed450,
    expected: expectedConnection,
  });
  rows.push({
    sourceLocation: "packages/core/src/errors.ts:455:15:normalizedError",
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
    "packages/core/src/errors.ts:468:15:normalizedError",
    "normalizedError",
    () => signatureError("provider.auth_failed", "evidence"),
  );
  annotate(observed463, expectedSignature);
  const checked463 = await assertErrorMigrationEvidence({
    sourceLocation: "packages/core/src/errors.ts:468:15:normalizedError",
    factory: "normalizedError",
    exercise: () => observed463,
    expected: expectedSignature,
  });
  rows.push({
    sourceLocation: "packages/core/src/errors.ts:468:15:normalizedError",
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
    "packages/core/src/errors.ts:481:15:normalizedError",
    "normalizedError",
    () => cancelledError("provider.auth_failed", "evidence"),
  );
  annotate(observed476, expectedCancelled);
  const checked476 = await assertErrorMigrationEvidence({
    sourceLocation: "packages/core/src/errors.ts:481:15:normalizedError",
    factory: "normalizedError",
    exercise: () => observed476,
    expected: expectedCancelled,
  });
  rows.push({
    sourceLocation: "packages/core/src/errors.ts:481:15:normalizedError",
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
    "packages/core/src/errors.ts:494:15:normalizedError",
    "normalizedError",
    () => interruptedError("provider.auth_failed", "evidence"),
  );
  annotate(observed489, expectedInterrupted);
  const checked489 = await assertErrorMigrationEvidence({
    sourceLocation: "packages/core/src/errors.ts:494:15:normalizedError",
    factory: "normalizedError",
    exercise: () => observed489,
    expected: expectedInterrupted,
  });
  rows.push({
    sourceLocation: "packages/core/src/errors.ts:494:15:normalizedError",
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
    "packages/core/src/errors.ts:507:15:normalizedError",
    "normalizedError",
    () => toolError("provider.auth_failed", "evidence"),
  );
  annotate(observed502, expectedTool);
  const checked502 = await assertErrorMigrationEvidence({
    sourceLocation: "packages/core/src/errors.ts:507:15:normalizedError",
    factory: "normalizedError",
    exercise: () => observed502,
    expected: expectedTool,
  });
  rows.push({
    sourceLocation: "packages/core/src/errors.ts:507:15:normalizedError",
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
    "packages/providers/src/common.ts:354:5:normalizeUnknownError",
    "normalizeUnknownError",
    () =>
      normalizeProviderError(new Error("evidence"), {
        code: "provider.upstream_failed",
        provider: "evidence",
      }),
  );
  annotate(observedProviderBoundary, expectedProviderBoundary);
  const checkedProviderBoundary = await assertErrorMigrationEvidence({
    sourceLocation: "packages/providers/src/common.ts:354:5:normalizeUnknownError",
    factory: "normalizeUnknownError",
    exercise: () => observedProviderBoundary,
    expected: expectedProviderBoundary,
  });
  rows.push({
    sourceLocation: "packages/providers/src/common.ts:354:5:normalizeUnknownError",
    factory: "normalizeUnknownError",
    observed: checkedProviderBoundary,
  });

  return rows;
}
