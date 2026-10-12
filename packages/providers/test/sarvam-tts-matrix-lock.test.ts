import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { acquireSarvamTtsMatrixLock } from "../../../scripts/sarvam-tts-matrix-lock.js";

describe("Sarvam TTS matrix lock", () => {
  it("prevents a second owner and releases its lock idempotently", () => {
    const outputDir = mkdtempSync(join(tmpdir(), "sarvam-matrix-lock-"));
    const lockFile = join(outputDir, ".sarvam-matrix.lock");

    try {
      const release = acquireSarvamTtsMatrixLock(outputDir);

      expect(existsSync(lockFile)).toBe(true);
      expect(() => acquireSarvamTtsMatrixLock(outputDir)).toThrow(
        /another Sarvam TTS matrix run owns/u,
      );

      release();
      expect(existsSync(lockFile)).toBe(false);
      expect(() => release()).not.toThrow();
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("does not remove a lock file after ownership has changed", () => {
    const outputDir = mkdtempSync(join(tmpdir(), "sarvam-matrix-lock-"));
    const lockFile = join(outputDir, ".sarvam-matrix.lock");

    try {
      const release = acquireSarvamTtsMatrixLock(outputDir);
      writeFileSync(lockFile, "replacement-owner\n");

      release();

      expect(readFileSync(lockFile, "utf8")).toBe("replacement-owner\n");
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });
});
