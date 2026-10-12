import { randomUUID } from "node:crypto";
import {
  closeSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

export const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647;
export const MAX_MATRIX_MANIFEST_BYTES = 8 * 1024 * 1024;
export const MAX_SARVAM_TTS_MATRIX_CONCURRENCY = 8;

export function matrixConcurrency(name: string, fallback: number): number {
  return parsePositiveInteger(name, process.env[name], fallback, MAX_SARVAM_TTS_MATRIX_CONCURRENCY);
}

export function parsePositiveInteger(
  name: string,
  raw: string | undefined,
  fallback: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isSafeInteger(maximum) || maximum < 1) {
    throw new RangeError("maximum must be a positive safe integer");
  }
  if (!Number.isSafeInteger(fallback) || fallback < 1 || fallback > maximum) {
    throw new RangeError("fallback must be a positive safe integer within the maximum");
  }
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${name} must be a positive integer no greater than ${maximum}`);
  }
  return value;
}

export function readBoundedJson<T>(file: string, maximumBytes: number): T {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new RangeError("maximumBytes must be a positive safe integer");
  }
  if (statSync(file).size > maximumBytes) {
    throw new Error(`JSON file exceeds the ${maximumBytes}-byte size limit`);
  }
  const contents = Buffer.alloc(maximumBytes + 1);
  const descriptor = openSync(file, "r");
  let bytesRead = 0;
  try {
    while (bytesRead < contents.byteLength) {
      const count = readSync(
        descriptor,
        contents,
        bytesRead,
        contents.byteLength - bytesRead,
        bytesRead,
      );
      if (count === 0) break;
      bytesRead += count;
    }
  } finally {
    closeSync(descriptor);
  }
  if (bytesRead > maximumBytes) {
    throw new Error(`JSON file exceeds the ${maximumBytes}-byte size limit`);
  }
  const source = contents.subarray(0, bytesRead).toString("utf8");
  return JSON.parse(source) as T;
}

export function writeJsonAtomically(file: string, value: unknown): void {
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(contents, "utf8") > MAX_MATRIX_MANIFEST_BYTES) {
    throw new Error(`JSON file exceeds the ${MAX_MATRIX_MANIFEST_BYTES}-byte size limit`);
  }
  const temporaryFile = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temporaryFile, contents);
    renameSync(temporaryFile, file);
  } catch (error) {
    try {
      unlinkSync(temporaryFile);
    } catch {
      // Keep cleanup best-effort; rethrow the original error.
    }
    throw error;
  }
}

export function writeFileAtomically(file: string, contents: Uint8Array): void {
  const temporaryFile = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryFile, contents, { flag: "wx" });
    renameSync(temporaryFile, file);
  } catch (error) {
    try {
      unlinkSync(temporaryFile);
    } catch {
      // Keep cleanup best-effort; rethrow the original error.
    }
    throw error;
  }
}
