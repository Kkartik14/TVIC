import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "tvic-error-inventory-"));
const fixtureScripts = path.join(fixtureRoot, "scripts");
const fixturePackages = path.join(fixtureRoot, "packages");

function runChecker() {
  return spawnSync(
    process.execPath,
    [path.join(fixtureScripts, "check-error-code-inventory.mjs"), "--release"],
    {
      cwd: fixtureRoot,
      encoding: "utf8",
      env: { ...process.env, TVIC_INVENTORY_ROOT: fixtureRoot },
    },
  );
}

function assertPass(result, context) {
  assert.equal(result.status, 0, `${context}: ${result.stderr || result.stdout}`);
}

function assertFail(result, expectedMessage, context) {
  assert.notEqual(result.status, 0, `${context} unexpectedly passed`);
  assert.match(`${result.stdout}\n${result.stderr}`, expectedMessage, context);
}

try {
  const sourceScripts = path.join(repositoryRoot, "scripts");
  // Keep a private source tree so movement fixtures never edit the checkout.
  mkdirSync(fixtureScripts, { recursive: true });
  cpSync(path.join(repositoryRoot, "packages"), fixturePackages, { recursive: true });
  for (const file of [
    "check-error-code-inventory.mjs",
    "error-code-inventory.json",
    "dynamic-code-evidence.json",
  ]) {
    cpSync(path.join(sourceScripts, file), path.join(fixtureScripts, file));
  }
  symlinkSync(
    path.join(repositoryRoot, "node_modules"),
    path.join(fixtureRoot, "node_modules"),
    "dir",
  );
  const manifestPath = path.join(fixtureScripts, "error-code-inventory.json");
  const positionedManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  for (const entry of positionedManifest.entries) {
    for (const location of entry.sourceLocations) {
      location.line = 1;
      location.column = 1;
    }
  }
  for (const entry of positionedManifest.durableCodes) {
    for (const location of entry.sourceLocations) {
      location.line = 1;
      location.column = 1;
    }
  }
  for (const entry of positionedManifest.dynamicCodes) {
    entry.line = 1;
    entry.column = 1;
  }
  writeFileSync(manifestPath, JSON.stringify(positionedManifest));

  const movedFiles = [
    "packages/core/src/errors.ts",
    "packages/core/src/dal-errors.ts",
    "packages/runtime/src/define-agent.ts",
  ];
  for (const relativeFile of movedFiles) {
    const file = path.join(fixtureRoot, relativeFile);
    writeFileSync(file, `\n\n${readFileSync(file, "utf8")}`);
  }
  assertPass(runChecker(), "moving named source functions must not stale the inventory");

  const movedManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const missingCodeManifest = structuredClone(movedManifest);
  missingCodeManifest.entries.pop();
  writeFileSync(manifestPath, JSON.stringify(missingCodeManifest));
  assertFail(runChecker(), /inventory is missing source codes/, "unlisted source code");

  const staleCodeManifest = structuredClone(movedManifest);
  staleCodeManifest.entries.push({
    ...staleCodeManifest.entries[0],
    code: "fixture.code_no_longer_in_source",
  });
  writeFileSync(manifestPath, JSON.stringify(staleCodeManifest));
  assertFail(runChecker(), /codes no longer present in source/, "inventory-only code");

  const incompleteMetadataManifest = structuredClone(movedManifest);
  delete incompleteMetadataManifest.entries[0].retryOwner;
  writeFileSync(manifestPath, JSON.stringify(incompleteMetadataManifest));
  assertFail(runChecker(), /missing: .*retryOwner/, "missing retry-owner metadata");

  process.stdout.write(
    "error-code inventory fixture passed: function movement is allowed; missing, stale, or incomplete codes are rejected\n",
  );
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}
