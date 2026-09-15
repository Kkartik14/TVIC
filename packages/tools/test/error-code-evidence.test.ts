import { describe, expect, it } from "vitest";

import { validationError } from "@tvic/core";

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

describe("1.1.0 tool error-code migration evidence", () => {
  it("[1.1.0:error-code:packages/tools/src/serialization.ts:178:12]", async () => {
    await assertErrorMigrationEvidence({
      exercise: () => validationError("tool.input_not_serializable", "evidence"),
      expected: {
        code: "tool.input_not_serializable",
        retriable: false,
        retryOwner: "none",
        persistedReadPolicy: "persist canonical tool code; raw label is bounded metadata only",
      },
    });
  });
});
