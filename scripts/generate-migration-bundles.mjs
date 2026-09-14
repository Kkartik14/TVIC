import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checkOnly = process.argv.includes("--check");
const targetArgumentIndex = process.argv.indexOf("--target");
const requestedTarget =
  targetArgumentIndex === -1 ? null : (process.argv[targetArgumentIndex + 1] ?? null);
const allTargets = [
  {
    key: "postgres",
    migrationsDirectory: path.join(repositoryRoot, "packages", "dal-postgres", "migrations"),
    outputFile: path.join(
      repositoryRoot,
      "packages",
      "dal-postgres",
      "src",
      "bundled-migrations.ts",
    ),
    exportName: "BUNDLED_POSTGRES_MIGRATIONS",
  },
  {
    key: "postgres-memory",
    migrationsDirectory: path.join(repositoryRoot, "packages", "dal-postgres-memory", "migrations"),
    outputFile: path.join(
      repositoryRoot,
      "packages",
      "dal-postgres-memory",
      "src",
      "bundled-migrations.ts",
    ),
    exportName: "BUNDLED_POSTGRES_MEMORY_MIGRATIONS",
  },
];
if (targetArgumentIndex !== -1 && !allTargets.some((target) => target.key === requestedTarget)) {
  throw new Error(
    `Unknown migration bundle target: ${String(requestedTarget)}. ` +
      `Expected one of: ${allTargets.map((target) => target.key).join(", ")}`,
  );
}
const targets =
  requestedTarget === null
    ? allTargets
    : allTargets.filter((target) => target.key === requestedTarget);

for (const target of targets) {
  const files = (await readdir(target.migrationsDirectory))
    .filter((file) => /^\d+_[^/]+\.sql$/.test(file))
    .sort();
  const migrations = await Promise.all(
    files.map(async (name) => ({
      version: Number(name.slice(0, name.indexOf("_"))),
      name,
      sql: await readFile(path.join(target.migrationsDirectory, name), "utf8"),
    })),
  );
  const generated = renderBundle(target.exportName, migrations);

  if (checkOnly) {
    const current = await readFile(target.outputFile, "utf8").catch(() => "");
    if (current !== generated) {
      throw new Error(
        `Migration bundle is stale: ${path.relative(repositoryRoot, target.outputFile)}`,
      );
    }
  } else {
    await writeFile(target.outputFile, generated, "utf8");
  }
}

if (checkOnly) {
  console.log("migration bundles are up to date");
}

function renderBundle(exportName, migrations) {
  const records = migrations
    .map(({ version, name, sql }) =>
      [
        "  {",
        `    version: ${version},`,
        `    name: ${JSON.stringify(name)},`,
        `    sql: String.raw\`${escapeTemplate(sql)}\`,`,
        "  },",
      ].join("\n"),
    )
    .join("\n");
  return `/**\n * GENERATED FILE. Run \`node scripts/generate-migration-bundles.mjs\`\n * after changing a migration SQL file. The .sql files remain the source of\n * truth and are also shipped for operators who prefer to inspect or run them\n * manually.\n */\nexport const ${exportName} = [\n${records}\n] as const;\n`;
}

function escapeTemplate(value) {
  return value.replaceAll("`", "\\`").replaceAll("${", "\\${");
}
