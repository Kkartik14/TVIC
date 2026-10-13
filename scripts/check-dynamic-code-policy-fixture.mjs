import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "tsx/esm/api";

register();

const {
  isValidErrorCode,
  MAX_ERROR_CODE_UTF8_BYTES,
  normalizedError,
  normalizedErrorFromErrorLike,
} = await import("../packages/core/src/errors.ts");
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  await readFile(path.join(repositoryRoot, "scripts", "error-code-inventory.json"), "utf8"),
);
const maxBytes = manifest.dynamicSchema?.maxCodeUtf8Bytes;
assert.equal(maxBytes, MAX_ERROR_CODE_UTF8_BYTES, "inventory and core error-code limits differ");

const expectedOverflowPolicy = {
  validated_passthrough: "reject_before_normalization",
  bounded_derived: "use_unknown_error",
  vendor_metadata: "omit_oversized_metadata",
  persisted_read: "return_null_and_raise_corrupt_record",
};
for (const [key, value] of Object.entries(expectedOverflowPolicy)) {
  assert.equal(manifest.dynamicSchema.overflowPolicy?.[key], value, `invalid ${key} policy`);
}

function codeAtBytes(bytes) {
  return `a.${"x".repeat(bytes - 2)}`;
}

for (const byteLength of [127, 128]) {
  const code = codeAtBytes(byteLength);
  const error = normalizedError(code, "boundary");
  assert.equal(Buffer.byteLength(error.code, "utf8"), byteLength);
}

assert.throws(() => normalizedError(codeAtBytes(129), "oversized"), TypeError);
assert.equal(isValidErrorCode("provider.failed\n"), false);

const overlongName = new TypeError("oversized Error name");
overlongName.name = "X".repeat(200);
const normalized = normalizedErrorFromErrorLike(overlongName);
assert.equal(normalized.code, "unknown.error");
assert.ok(Buffer.byteLength(normalized.code, "utf8") <= maxBytes);

process.stdout.write(
  "dynamic code policy fixture ok: production core accepts 127/128 and rejects 129\n",
);
