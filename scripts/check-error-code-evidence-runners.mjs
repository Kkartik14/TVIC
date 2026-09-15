import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  await readFile(
    path.join(repositoryRoot, "docs/decisions/1.1.0-error-code-migration.json"),
    "utf8",
  ),
);
const missing = [];
const invalid = [];
for (const requiredFile of ["scripts/run-dual-protocol-stress.mjs"]) {
  try {
    await access(path.join(repositoryRoot, requiredFile));
  } catch {
    missing.push(`required acceptance runner: ${requiredFile}`);
  }
}
for (const mapping of manifest.dynamicMappings ?? []) {
  const runner = mapping.evidenceRunner;
  if (!runner?.file || !runner.export) {
    invalid.push(mapping.key ?? "<unknown>");
    continue;
  }
  const file = path.join(repositoryRoot, runner.file);
  try {
    await access(file);
    const source = await readFile(file, "utf8");
    if (
      !new RegExp(
        `(?:export\\s+)?(?:async\\s+)?function\\s+${runner.export}\\b|export\\s+(?:const|let|var)\\s+${runner.export}\\b`,
      ).test(source)
    ) {
      invalid.push(`${mapping.key}: missing export ${runner.export}`);
    }
  } catch {
    missing.push(`${mapping.key}: ${runner.file}`);
  }
}
if (invalid.length > 0 || missing.length > 0) {
  throw new Error(
    [
      invalid.length > 0 ? `invalid evidence runners: ${invalid.join(", ")}` : "",
      missing.length > 0 ? `missing evidence runners: ${missing.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
}
process.stdout.write(`error-code evidence runners ok: ${manifest.dynamicMappings.length}\n`);
