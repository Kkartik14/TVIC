import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const plan = await readFile(
  path.join(repositoryRoot, "local/superpowers/team-1-1.1.0-plan.md"),
  "utf8",
);
const evidenceHeading = "### 13.8 Acceptance-row evidence index";
const evidenceStart = plan.indexOf(evidenceHeading);
if (evidenceStart < 0) throw new Error("acceptance evidence index is missing");

function collectIds(text) {
  return [
    ...text.matchAll(/^\|\s*([A-Z]+)-(\d+[a-z]?)(?:\s+through\s+([A-Z]+)-(\d+[a-z]?))?\s*\|/gm),
  ].flatMap(([, prefix, first, endPrefix, last]) => {
    if (!endPrefix) return [`${prefix}-${first}`];
    if (!/^\d+$/.test(first) || !/^\d+$/.test(last) || prefix !== endPrefix) {
      return [`${prefix}-${first}`, `${endPrefix}-${last}`];
    }
    return Array.from(
      { length: Number(last) - Number(first) + 1 },
      (_, offset) => `${prefix}-${String(Number(first) + offset).padStart(2, "0")}`,
    );
  });
}

const regressionMatrix = "| L-04a | attached session |\n| L-04b | deferred claim |";
if (!collectIds(regressionMatrix).includes("L-04a")) {
  throw new Error("acceptance evidence fixture cannot parse alphanumeric IDs");
}
const regressionMissing = collectIds(regressionMatrix).filter(
  (id) => !collectIds("| L-04a | test file |").includes(id),
);
if (!regressionMissing.includes("L-04b")) {
  throw new Error("acceptance evidence fixture did not detect missing L-04b evidence");
}

const matrixIds = new Set(collectIds(plan.slice(0, evidenceStart)));
const evidenceEnd = plan.indexOf("\nThe exact-tag workflow", evidenceStart);
const evidenceText = plan.slice(evidenceStart, evidenceEnd < 0 ? plan.length : evidenceEnd);
const evidenceIds = new Set(collectIds(evidenceText));
const missing = [...matrixIds].filter((id) => !evidenceIds.has(id));
if (missing.length > 0) {
  throw new Error(`acceptance rows missing executable evidence mapping: ${missing.join(", ")}`);
}

const evidenceRows = evidenceText
  .split(/\r?\n/)
  .filter((line) =>
    /^\|\s*(?:[A-Z]+-\d+[a-z]?|[A-Z]+-\d+[a-z]?\s+through\s+[A-Z]+-\d+[a-z]?)\s*\|/.test(line),
  )
  .map((line) =>
    line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim()),
  );
for (const [acceptanceRows, primaryEvidence, command] of evidenceRows) {
  if (
    !primaryEvidence?.includes("`") ||
    !command?.includes("`") ||
    !/^\s*`?(?:pnpm|node|npm|git)\b/.test(command)
  ) {
    throw new Error(
      `acceptance evidence row ${acceptanceRows} must name a concrete file and command`,
    );
  }
}

if (process.argv.includes("--require-files")) {
  const missingFiles = new Set();
  const outsideFiles = new Set();
  const rowsWithoutPaths = new Set();
  const pathLikeRootFile =
    /^(?:\.[A-Za-z0-9_.-]+|[A-Za-z0-9_.-]+\.[A-Za-z0-9_-]+|README|LICENSE|Makefile)$/;
  const cleanPathCandidate = (value) =>
    value
      .trim()
      .replace(/^[([{]+/, "")
      .replace(/[.,;:)\]}]+$/, "")
      .replace(/^['"]|['"]$/g, "")
      .replace(/^[|;&]+|[|;&]+$/g, "")
      .replace(/:\d+(?::\d+)?$/, "");
  const isPathCandidate = (value) => {
    const candidate = cleanPathCandidate(value);
    if (
      !candidate ||
      candidate.startsWith("@") ||
      candidate.startsWith("--") ||
      candidate.includes("://") ||
      /\s/.test(candidate)
    ) {
      return false;
    }
    return (
      path.isAbsolute(candidate) ||
      candidate.startsWith("./") ||
      candidate.startsWith("../") ||
      candidate.includes("/") ||
      pathLikeRootFile.test(candidate)
    );
  };
  const referencesInCell = (cell, kind) => {
    const references = new Set();
    const codeSpans = [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
    for (const span of codeSpans) {
      const values = kind === "command" ? span.split(/\s+/) : [span];
      for (const value of values) {
        if (isPathCandidate(value)) references.add(cleanPathCandidate(value));
      }
    }
    const withoutCodeSpans = cell.replace(/`[^`]*`/g, " ");
    for (const match of withoutCodeSpans.matchAll(
      /(?:^|[\s([,{;])([^\s"'`()\[\]{},;]+)(?=$|[\s)\]},;])/g,
    )) {
      if (isPathCandidate(match[1])) references.add(cleanPathCandidate(match[1]));
    }
    for (const match of withoutCodeSpans.matchAll(/['"]([^'"]+)['"]/g)) {
      if (isPathCandidate(match[1])) references.add(cleanPathCandidate(match[1]));
    }
    return references;
  };
  const packageDirectories = new Map();
  for (const packageRoot of ["packages", "examples"]) {
    let entries = [];
    try {
      entries = await readdir(path.join(repositoryRoot, packageRoot), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const packageJson = JSON.parse(
          await readFile(
            path.join(repositoryRoot, packageRoot, entry.name, "package.json"),
            "utf8",
          ),
        );
        if (typeof packageJson.name === "string") {
          packageDirectories.set(packageJson.name, `${packageRoot}/${entry.name}`);
        }
      } catch {
        // A directory without a package manifest cannot resolve package-relative command paths.
      }
    }
  }
  const commandPackageDirectories = (command) => {
    return [
      ...new Set(
        [...command.matchAll(/(?:^|\s)--filter\s+([^\s`]+)/g)]
          .map((match) => packageDirectories.get(match[1]))
          .filter(Boolean),
      ),
    ];
  };
  const resolveEvidencePaths = (relativePath, packageDirectoriesForCommand) => {
    const bases = [repositoryRoot];
    if (/^(?:test|src|dist)\//.test(relativePath)) {
      bases.push(
        ...packageDirectoriesForCommand.map((packageDirectory) =>
          path.join(repositoryRoot, packageDirectory),
        ),
      );
    }
    const candidates = [];
    let hadOutsideCandidate = false;
    for (const base of bases) {
      const absolute = path.resolve(base, relativePath);
      const fromRoot = path.relative(repositoryRoot, absolute);
      if (fromRoot === "" || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) {
        hadOutsideCandidate = true;
        continue;
      }
      candidates.push(absolute);
    }
    if (candidates.length === 0 && hadOutsideCandidate) outsideFiles.add(relativePath);
    return candidates;
  };
  const pathFixture = referencesInCell('`src/fixture.test.ts` and "./root-fixture.md"', "primary");
  const commandFixture = referencesInCell(
    "`pnpm --filter @tvic/runtime exec vitest run test/runtime.test.ts`",
    "command",
  );
  if (
    !pathFixture.has("src/fixture.test.ts") ||
    !pathFixture.has("./root-fixture.md") ||
    !commandFixture.has("test/runtime.test.ts") ||
    resolveEvidencePaths("../outside-fixture.ts", []).length !== 0 ||
    !outsideFiles.has("../outside-fixture.ts")
  ) {
    throw new Error("acceptance evidence path fixture does not enforce repository-relative files");
  }
  outsideFiles.delete("../outside-fixture.ts");
  for (const [acceptanceRows, primaryEvidence, command] of evidenceRows) {
    const references = new Set([
      ...referencesInCell(primaryEvidence, "primary"),
      ...referencesInCell(command, "command"),
    ]);
    if (references.size === 0) rowsWithoutPaths.add(acceptanceRows);
    const packageDirectoriesForCommand = commandPackageDirectories(command);
    for (const relativePath of references) {
      const candidatePaths = resolveEvidencePaths(relativePath, packageDirectoriesForCommand);
      let present = false;
      for (const absolutePath of candidatePaths) {
        try {
          await readFile(absolutePath, "utf8");
          present = true;
          break;
        } catch {
          // Try the next package-relative interpretation when a command has multiple filters.
        }
      }
      if (!present && candidatePaths.length > 0) {
        missingFiles.add(relativePath);
      }
    }
  }
  if (rowsWithoutPaths.size > 0) {
    throw new Error(
      `acceptance evidence rows name no repository file: ${[...rowsWithoutPaths].join(", ")}`,
    );
  }
  if (outsideFiles.size > 0) {
    throw new Error(
      `acceptance evidence references paths outside the repository: ${[...outsideFiles].join(", ")}`,
    );
  }
  if (missingFiles.size > 0) {
    throw new Error(
      `acceptance evidence references files that are not present: ${[...missingFiles].join(", ")}`,
    );
  }
}

process.stdout.write(
  `acceptance evidence ok: ${matrixIds.size} matrix rows mapped to executable evidence${
    process.argv.includes("--require-files") ? " and present files" : ""
  }\n`,
);
