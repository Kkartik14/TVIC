import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  MAX_MATRIX_MANIFEST_BYTES,
  MAX_SARVAM_TTS_MATRIX_CONCURRENCY,
  MAX_NODE_TIMER_DELAY_MS,
  matrixConcurrency,
  parsePositiveInteger,
  readBoundedJson,
  writeFileAtomically,
  writeJsonAtomically,
} from "../../../scripts/sarvam-tts-live-limits.js";
import { acquireSarvamTtsMatrixLock } from "../../../scripts/sarvam-tts-matrix-lock.js";

describe("Sarvam live harness limits", () => {
  it("rejects timer values above Node's supported timeout range", () => {
    expect(parsePositiveInteger("TIMEOUT_MS", undefined, 1_000, MAX_NODE_TIMER_DELAY_MS)).toBe(
      1_000,
    );
    expect(
      parsePositiveInteger(
        "TIMEOUT_MS",
        String(MAX_NODE_TIMER_DELAY_MS),
        1_000,
        MAX_NODE_TIMER_DELAY_MS,
      ),
    ).toBe(MAX_NODE_TIMER_DELAY_MS);
    expect(() =>
      parsePositiveInteger(
        "TIMEOUT_MS",
        String(MAX_NODE_TIMER_DELAY_MS + 1),
        1_000,
        MAX_NODE_TIMER_DELAY_MS,
      ),
    ).toThrow(/no greater than 2147483647/);
  });

  it("bounds manifest input and atomically replaces manifest output", () => {
    const directory = mkdtempSync(join(tmpdir(), "sarvam-live-limits-"));
    const manifest = join(directory, "manifest.json");
    try {
      writeFileSync(manifest, JSON.stringify({ state: "old" }));
      writeJsonAtomically(manifest, { state: "new" });
      expect(readBoundedJson<{ state: string }>(manifest, 64)).toEqual({ state: "new" });

      writeFileSync(manifest, "x".repeat(MAX_MATRIX_MANIFEST_BYTES + 1));
      expect(() => readBoundedJson(manifest, MAX_MATRIX_MANIFEST_BYTES)).toThrow(
        /exceeds the 8388608-byte size limit/,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects an oversized atomic manifest write without replacing the prior file", () => {
    const directory = mkdtempSync(join(tmpdir(), "sarvam-live-limits-"));
    const manifest = join(directory, "manifest.json");
    const prior = JSON.stringify({ state: "prior" });
    try {
      writeFileSync(manifest, prior);

      expect(() =>
        writeJsonAtomically(manifest, { payload: "x".repeat(MAX_MATRIX_MANIFEST_BYTES) }),
      ).toThrow(/exceeds the 8388608-byte size limit/u);

      expect(readFileSync(manifest, "utf8")).toBe(prior);
      expect(readdirSync(directory)).toEqual(["manifest.json"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("caps live matrix concurrency at the configured safe ceiling", () => {
    const variable = "SARVAM_TTS_MATRIX_CONCURRENCY";
    const prior = process.env[variable];
    try {
      process.env[variable] = String(MAX_SARVAM_TTS_MATRIX_CONCURRENCY);
      expect(matrixConcurrency(variable, 3)).toBe(MAX_SARVAM_TTS_MATRIX_CONCURRENCY);
      process.env[variable] = String(MAX_SARVAM_TTS_MATRIX_CONCURRENCY + 1);
      expect(() => matrixConcurrency(variable, 3)).toThrow(/no greater than/u);
    } finally {
      if (prior === undefined) delete process.env[variable];
      else process.env[variable] = prior;
    }
  });

  it("publishes audio by replacing the destination from a same-directory temporary file", () => {
    const directory = mkdtempSync(join(tmpdir(), "sarvam-live-artifact-"));
    const artifact = join(directory, "output.wav");
    const bytes = Buffer.from([1, 2, 3, 4]);
    try {
      writeFileSync(artifact, Buffer.from([9, 9]));
      writeFileAtomically(artifact, bytes);

      expect(readFileSync(artifact)).toEqual(bytes);
      expect(readdirSync(directory)).toEqual(["output.wav"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("Sarvam matrix output lock", () => {
  it("rejects a second writer and permits a new owner after release", () => {
    const directory = mkdtempSync(join(tmpdir(), "sarvam-matrix-lock-"));
    const release = acquireSarvamTtsMatrixLock(directory);
    try {
      expect(() => acquireSarvamTtsMatrixLock(directory)).toThrow(
        /another Sarvam TTS matrix run.*\.sarvam-matrix\.lock/u,
      );
    } finally {
      release();
    }

    try {
      const nextRelease = acquireSarvamTtsMatrixLock(directory);
      nextRelease();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
