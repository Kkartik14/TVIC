import { serializabilityError } from "../src/serialization.ts";

export const evidenceSourceBindings = [
  {
    file: "packages/tools/src/serialization.ts",
    factories: ["validationError"],
  },
];

export async function runErrorMigrationEvidence({
  recordFactoryCall,
  assertErrorMigrationEvidence,
}) {
  const expected = {
    code: "tool.input_not_serializable",
    retriable: false,
    retryOwner: "none",
    persistedReadPolicy: "persist canonical tool code; raw label is bounded metadata only",
  };
  const observed = await recordFactoryCall(
    "packages/tools/src/serialization.ts:134:12:validationError",
    "validationError",
    () => serializabilityError(1n, "input"),
  );
  const checked = await assertErrorMigrationEvidence({
    sourceLocation: "packages/tools/src/serialization.ts:134:12:validationError",
    factory: "validationError",
    exercise: () => observed,
    expected,
  });
  return [
    {
      sourceLocation: "packages/tools/src/serialization.ts:134:12:validationError",
      factory: "validationError",
      observed: checked,
    },
  ];
}
