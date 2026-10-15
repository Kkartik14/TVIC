import { normalizedErrorFromErrorLike } from "../src/errors.ts";

export const evidenceSourceBindings = [
  {
    file: "packages/core/src/errors.ts",
    factories: ["normalizedError"],
  },
];

export async function runErrorMigrationEvidence({
  recordFactoryCall,
  assertErrorMigrationEvidence,
}) {
  const expected = {
    code: "error.type_error",
    retriable: false,
    retryOwner: "none",
    persistedReadPolicy: "unknown persisted code is never retriable",
  };
  const observed = await recordFactoryCall(
    "packages/core/test/error-code-evidence.test.ts#normalizedErrorFromErrorLike",
    "normalizedError",
    () => normalizedErrorFromErrorLike(new TypeError("evidence")),
  );
  const checked = await assertErrorMigrationEvidence({
    evidenceKey: "packages/core/test/error-code-evidence.test.ts#normalizedErrorFromErrorLike",
    factory: "normalizedError",
    exercise: () => observed,
    expected,
  });
  return [
    {
      evidenceKey: "packages/core/test/error-code-evidence.test.ts#normalizedErrorFromErrorLike",
      factory: "normalizedError",
      observed: checked,
    },
  ];
}
