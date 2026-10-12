import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const SARVAM_MATRIX_LOCK_FILE = ".sarvam-matrix.lock";

export function acquireSarvamTtsMatrixLock(outputDir: string): () => void {
  const lockFile = resolve(outputDir, SARVAM_MATRIX_LOCK_FILE);
  const owner = `${process.pid}:${randomUUID()}\n`;
  try {
    writeFileSync(lockFile, owner, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    let existingOwner = "unknown owner";
    try {
      existingOwner = readFileSync(lockFile, "utf8").trim() || existingOwner;
    } catch {
      // The path may have been removed or replaced while producing the diagnostic.
    }
    throw new Error(
      `another Sarvam TTS matrix run owns ${lockFile} (${existingOwner}); ` +
        "if that run stopped unexpectedly, verify no matrix process is active and remove the lock file before retrying",
    );
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      if (readFileSync(lockFile, "utf8") === owner) unlinkSync(lockFile);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  };
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}
