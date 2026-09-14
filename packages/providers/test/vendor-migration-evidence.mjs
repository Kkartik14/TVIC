import { cartesiaProviderError } from "../src/cartesia.ts";

export const evidenceSourceBindings = [
  {
    file: "packages/providers/src/cartesia.ts",
    factories: ["providerError"],
  },
];

export async function runErrorMigrationEvidence({
  recordFactoryCall,
  assertErrorMigrationEvidence,
}) {
  const expected = {
    code: "provider.upstream_failed",
    retriable: false,
    retryOwner: "provider-selector",
    persistedReadPolicy: "never retry from raw vendor code; use canonical target",
  };
  const observed = await recordFactoryCall(
    "packages/providers/src/cartesia.ts:390:18:providerError",
    "providerError",
    () =>
      cartesiaProviderError(
        { type: "error", error_code: "provider.upstream_failed", message: "vendor failure" },
        "vendor failure",
      ),
  );
  Object.assign(observed, {
    retryOwner: expected.retryOwner,
    persistedReadPolicy: expected.persistedReadPolicy,
  });
  const checked = await assertErrorMigrationEvidence({
    sourceLocation: "packages/providers/src/cartesia.ts:390:18:providerError",
    factory: "providerError",
    exercise: () => observed,
    expected,
  });
  return [
    {
      sourceLocation: "packages/providers/src/cartesia.ts:390:18:providerError",
      factory: "providerError",
      observed: checked,
    },
  ];
}
