import { describe, expect, it } from "vitest";

import {
  recordMatrixArtifactCompletion,
  recordMatrixCompletion,
} from "../../../scripts/sarvam-tts-matrix-checkpoint.js";

describe("Sarvam matrix checkpoints", () => {
  it("persists every completed case before the matrix advances", () => {
    const records: Array<string | undefined> = [undefined, undefined, undefined];
    const checkpoints: Array<Array<string | undefined>> = [];
    const persist = (snapshot: readonly (string | undefined)[]): void => {
      checkpoints.push([...snapshot]);
    };

    recordMatrixCompletion(records, 0, "first", persist);
    recordMatrixCompletion(records, 2, "third", persist);

    expect(checkpoints).toEqual([
      ["first", undefined, undefined],
      ["first", undefined, "third"],
    ]);
  });

  it("checkpoints completed metadata before publishing audio, then marks the artifact passed", () => {
    type Record = { readonly status: "pending" | "passed" };
    const records: Array<Record | undefined> = [undefined];
    const order: string[] = [];

    recordMatrixArtifactCompletion(
      records,
      0,
      { status: "pending" },
      { status: "passed" },
      () => order.push("audio"),
      (snapshot) => order.push(`manifest:${snapshot[0]?.status}`),
    );

    expect(order).toEqual(["manifest:pending", "audio", "manifest:passed"]);
  });
});
