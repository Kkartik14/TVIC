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
    "packages/core/src/errors.ts:609:10:normalizedError",
    "normalizedError",
    () => normalizedErrorFromErrorLike(new TypeError("evidence")),
  );
  const checked = await assertErrorMigrationEvidence({
    sourceLocation: "packages/core/src/errors.ts:609:10:normalizedError",
    factory: "normalizedError",
    exercise: () => observed,
    expected,
  });
  return [
    {
      sourceLocation: "packages/core/src/errors.ts:609:10:normalizedError",
      factory: "normalizedError",
      observed: checked,
    },
  ];
}
