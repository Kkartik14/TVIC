import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(repositoryRoot, "scripts/acceptance-evidence.json");
let manifest;
try {
  manifest = JSON.parse(await readFile(manifestPath, "utf8"));
} catch (error) {
  throw new Error("tracked acceptance evidence manifest is missing or invalid", { cause: error });
}

if (
  !manifest ||
  manifest.version !== 1 ||
  !Array.isArray(manifest.rows) ||
  manifest.rows.length === 0
) {
  throw new Error("tracked acceptance evidence manifest must contain version 1 rows");
}

const ids = new Set();
const evidenceRows = [];
for (const row of manifest.rows) {
  if (
    !row ||
    typeof row.id !== "string" ||
    !/^[A-Z][A-Z0-9]*-\d+[a-z]?$/.test(row.id) ||
    typeof row.primary !== "string" ||
    typeof row.command !== "string"
  ) {
    throw new Error("each acceptance evidence row needs an ID, primary path, and command");
  }
  if (ids.has(row.id)) throw new Error(`duplicate acceptance evidence row: ${row.id}`);

  const paths = [...row.primary.matchAll(/`([^`]+)`/g)].map(([, value]) => value.trim());
  const commands = [...row.command.matchAll(/`([^`]+)`/g)].map(([, value]) => value.trim());
  if (
    paths.length === 0 ||
    paths.some((value) => path.isAbsolute(value) || value.split(/[\\/]/).includes(".."))
  ) {
    throw new Error(`acceptance evidence row ${row.id} must name repository-relative source files`);
  }
  if (commands.length === 0 || commands.some((value) => !/^(?:pnpm|node|npm|git)\b/.test(value))) {
    throw new Error(`acceptance evidence row ${row.id} must name concrete commands`);
  }

  ids.add(row.id);
  evidenceRows.push({ id: row.id, paths });
}

if (process.argv.includes("--require-files")) {
  const missingFiles = new Set();
  for (const { id, paths } of evidenceRows) {
    for (const relativePath of paths) {
      const absolutePath = path.resolve(repositoryRoot, relativePath);
      const fromRoot = path.relative(repositoryRoot, absolutePath);
      if (fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) {
        throw new Error(`acceptance evidence row ${id} references a path outside the repository`);
      }
      try {
        await readFile(absolutePath, "utf8");
      } catch {
        missingFiles.add(relativePath);
      }
    }
  }
  if (missingFiles.size > 0) {
    throw new Error(
      `acceptance evidence references files that are not present: ${[...missingFiles].join(", ")}`,
    );
  }
}

process.stdout.write(
  `acceptance evidence map ok: ${ids.size} rows${
    process.argv.includes("--require-files") ? " and present source files" : ""
  }\n`,
);
