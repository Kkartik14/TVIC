import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PACKAGES_DIR = path.join(REPO_ROOT, "packages");
const requireFromHere = createRequire(import.meta.url);

function runtimeTargetFor(exportEntry, condition = "import") {
  if (typeof exportEntry === "string") {
    return condition === "require" ? undefined : exportEntry;
  }
  if (exportEntry && typeof exportEntry === "object") {
    return condition === "require"
      ? exportEntry.require
      : (exportEntry.import ?? exportEntry.default);
  }
  return undefined;
}

async function discoverPackages() {
  const entries = await readdir(PACKAGES_DIR, { withFileTypes: true });
  const packages = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const manifestPath = path.join(PACKAGES_DIR, entry.name, "package.json");
    let manifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch {
      continue;
    }
    if (typeof manifest.exports !== "object" || manifest.exports === null) {
      continue;
    }
    packages.push({
      name: typeof manifest.name === "string" ? manifest.name : entry.name,
      dir: path.join(PACKAGES_DIR, entry.name),
      exports: manifest.exports,
    });
  }
  return packages;
}

const failures = [];
const checked = [];

for (const pkg of await discoverPackages()) {
  for (const [exportKey, exportEntry] of Object.entries(pkg.exports)) {
    const relativeTarget = runtimeTargetFor(exportEntry);
    if (relativeTarget === undefined) {
      failures.push(
        `${pkg.name} "${exportKey}": no runtime target in export entry ` +
          `(expected an "import" or "default" condition)`,
      );
      continue;
    }
    if (relativeTarget.endsWith(".d.ts")) {
      continue;
    }
    const absoluteTarget = path.resolve(pkg.dir, relativeTarget);
    const specifier = pathToFileURL(absoluteTarget).href;

    try {
      const namespace = await import(specifier);
      const exportCount = Object.keys(namespace).length;
      if (exportCount === 0 && !("default" in namespace)) {
        failures.push(
          `${pkg.name} "${exportKey}" (${relativeTarget}): loaded but exposes no exports`,
        );
        continue;
      }
      checked.push(`${pkg.name} "${exportKey}" -> ${exportCount} exports`);

      const requireTarget = runtimeTargetFor(exportEntry, "require");
      if (requireTarget !== undefined && !requireTarget.endsWith(".d.ts")) {
        const requireAbsoluteTarget = path.resolve(pkg.dir, requireTarget);
        try {
          const required = requireFromHere(requireAbsoluteTarget);
          const requireExportCount = Object.keys(required).length;
          if (requireExportCount === 0 && !("default" in required)) {
            failures.push(
              `${pkg.name} "${exportKey}" (${requireTarget}): loaded but exposes no exports`,
            );
            continue;
          }
          checked.push(`${pkg.name} "${exportKey}" require -> ${requireExportCount} exports`);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          failures.push(`${pkg.name} "${exportKey}" require (${requireTarget}): ${reason}`);
        }
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      failures.push(`${pkg.name} "${exportKey}" (${relativeTarget}): ${reason}`);
    }
  }
}

if (checked.length === 0) {
  failures.unshift("no package export entries were discovered under packages/");
}

if (failures.length > 0) {
  console.error(`check-package-exports: ${failures.length} failure(s):`);
  for (const failure of failures) {
    console.error(`  ${failure}`);
  }
  process.exit(1);
}

console.log(
  `check-package-exports: ${checked.length} entr${checked.length === 1 ? "y" : "ies"} load cleanly:`,
);
for (const line of checked.sort()) {
  console.log(`  ${line}`);
}
