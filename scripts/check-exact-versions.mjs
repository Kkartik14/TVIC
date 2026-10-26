import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exactVersion = /^(\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?|workspace:.+|file:.+|link:.+)$/;
const caretRange = /^\^\d+\.\d+\.\d+$/;
const dependencyFields = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
const errors = [];

const manifests = execFileSync("git", ["ls-files", "package.json", "**/package.json"], {
  cwd: repositoryRoot,
  encoding: "utf8",
})
  .split("\n")
  .filter(Boolean);

for (const relativePath of manifests) {
  const manifest = JSON.parse(await readFile(path.join(repositoryRoot, relativePath), "utf8"));
  for (const field of dependencyFields) {
    const shipped = field === "dependencies" && manifest.private !== true;
    for (const [name, version] of Object.entries(manifest[field] ?? {})) {
      if (exactVersion.test(version) || (shipped && caretRange.test(version))) continue;
      errors.push(`${relativePath} ${field}.${name}: ${version}`);
    }
  }
}

if (errors.length > 0) {
  throw new Error(
    `Dependencies must be exact versions (a published package's dependencies may use ^x.y.z):\n${errors.join("\n")}`,
  );
}

process.stdout.write(`Exact versions ok: ${manifests.length} manifests\n`);
