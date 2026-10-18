import { describe, expect, it } from "vitest";

import { serializabilityError } from "../src/serialization.js";

type Evidence = {
  readonly exercise: () => unknown | Promise<unknown>;
  readonly expected: {
    readonly code: string;
    readonly retriable: boolean;
  };
};

async function assertErrorMigrationEvidence({ exercise, expected }: Evidence): Promise<unknown> {
  const actual = await exercise();
  expect(actual).toMatchObject({ code: expected.code, retriable: expected.retriable });
  return actual;
}

describe("1.1.0 tool error-code migration evidence", () => {
  it("[1.1.0:error-code:packages/tools/src/serialization.ts:131:12]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () => serializabilityError(1n, "input"),
      expected: {
        code: "tool.input_not_serializable",
        retriable: false,
      },
    });
  });
});
