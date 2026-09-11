import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  await readFile(
    path.join(repositoryRoot, "docs", "decisions", "1.1.0-error-code-migration.json"),
    "utf8",
  ),
);
const maxBytes = manifest.dynamicSchema?.maxCodeUtf8Bytes;
if (maxBytes !== 128) throw new Error(`expected a 128-byte bound, got ${String(maxBytes)}`);
const expectedOverflowPolicy = {
  validated_passthrough: "reject_before_normalization",
  bounded_derived: "use_unknown_error",
  vendor_metadata: "omit_oversized_metadata",
  persisted_read: "return_null_and_raise_corrupt_record",
};
for (const [key, value] of Object.entries(expectedOverflowPolicy)) {
  if (manifest.dynamicSchema.overflowPolicy?.[key] !== value) {
    throw new Error(`overflow policy ${key} is not deterministic`);
  }
}

function codeAtBytes(bytes) {
  let code = "a.";
  while (Buffer.byteLength(code, "utf8") < bytes) {
    const remaining = bytes - Buffer.byteLength(code, "utf8");
    code += remaining >= 2 ? "é" : "x";
  }
  return code;
}

function acceptPassthrough(code) {
  if (Buffer.byteLength(code, "utf8") > maxBytes) {
    throw new TypeError("code exceeds the dynamic-code byte bound");
  }
  return {
    code,
    retriable: false,
    persistedReadPolicy: "unknown persisted code is never retriable",
  };
}

function deriveErrorName(name) {
  const segment = name.replace(/[^A-Za-z0-9_]+/g, "_").toLowerCase();
  const code = `error.${segment || "unknown"}`;
  return Buffer.byteLength(code, "utf8") <= maxBytes ? code : "unknown.error";
}

function boundedVendorMetadata(value) {
  return Buffer.byteLength(value, "utf8") <= maxBytes ? value : undefined;
}

function readPersistedCode(value) {
  return Buffer.byteLength(value, "utf8") <= maxBytes ? value : null;
}

for (const bytes of [127, 128]) {
  const result = acceptPassthrough(codeAtBytes(bytes));
  if (!result.code.includes("é")) throw new Error(`boundary ${bytes} did not exercise UTF-8`);
  if (Buffer.byteLength(result.code, "utf8") !== bytes) {
    throw new Error(`passthrough boundary ${bytes} was not preserved`);
  }
}
try {
  acceptPassthrough(codeAtBytes(129));
  throw new Error("129-byte passthrough code was accepted");
} catch (error) {
  if (!(error instanceof TypeError)) throw error;
}
if (deriveErrorName("x".repeat(200)) !== "unknown.error") {
  throw new Error("overlong derived Error name did not use unknown.error");
}
if (boundedVendorMetadata(codeAtBytes(128)) === undefined) {
  throw new Error("128-byte vendor metadata was omitted");
}
if (boundedVendorMetadata(codeAtBytes(129)) !== undefined) {
  throw new Error("overlong vendor metadata was retained");
}
if (readPersistedCode(codeAtBytes(128)) === null) {
  throw new Error("128-byte persisted code was rejected");
}
if (readPersistedCode(codeAtBytes(129)) !== null) {
  throw new Error("overlong persisted code was accepted");
}

process.stdout.write("dynamic code policy fixture ok: 127/128 accepted, 129 rejected\n");
