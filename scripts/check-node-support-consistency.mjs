import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const supportedLines = ["22", "24", "26"];
const expectedEngine = "^22.0.0 || ^24.0.0 || ^26.0.0";
const errors = [];

function hasExactSupportedMatrix(versions) {
  return (
    versions.length === supportedLines.length &&
    new Set(versions).size === supportedLines.length &&
    supportedLines.every((version) => versions.includes(version))
  );
}

async function readJson(relativePath) {
  const file = path.join(repositoryRoot, relativePath);
  return JSON.parse(await readFile(file, "utf8"));
}

async function listTypeScriptFiles(directory) {
  const result = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && /\.tsx?$/.test(entry.name)) result.push(absolute);
    }
  }
  await visit(directory);
  return result.sort();
}

function requireEqual(label, actual, expected) {
  if (actual !== expected) errors.push(`${label}: expected ${expected}, got ${actual}`);
}

const packageEntries = await readdir(path.join(repositoryRoot, "packages"), {
  withFileTypes: true,
});
const packageJsonPaths = new Set([
  "package.json",
  ...packageEntries
    .filter((value) => value.isDirectory())
    .map((entry) => `packages/${entry.name}/package.json`),
]);
for (const relativePath of packageJsonPaths) {
  try {
    const packageJson = await readJson(relativePath);
    if (relativePath === "package.json" || packageJson.engines?.node !== undefined) {
      requireEqual(`${relativePath} engines.node`, packageJson.engines.node, expectedEngine);
    }
  } catch {
    // A source package without package.json is not a published support claim.
  }
}

const supportDocs = [
  "README.md",
  "packages/voice-runtime/README.md",
  "docs/decisions/1.1.0-public-api.md",
];
const nodeVersionClaim = /\bNode(?:\.js)?\s*(\d{2})\b/i;
const publicSourceFiles = (
  await Promise.all(
    packageEntries.map(async (entry) => {
      const sourceRoot = path.join(repositoryRoot, "packages", entry.name, "src");
      try {
        return await listTypeScriptFiles(sourceRoot);
      } catch {
        return [];
      }
    }),
  )
).flat();
for (const relativePath of [
  ...supportDocs,
  ...publicSourceFiles.map((file) => path.relative(repositoryRoot, file)),
]) {
  const text = await readFile(path.join(repositoryRoot, relativePath), "utf8");
  for (const match of text.matchAll(new RegExp(nodeVersionClaim.source, "gi"))) {
    if (!match || supportedLines.includes(match[1])) continue;
    const context = text.slice(match.index, (match.index ?? 0) + 160);
    if (/outside|unsupported|not supported|no longer supported/i.test(context)) continue;
    errors.push(`${relativePath}: contains an unsupported positive Node ${match[1]} claim`);
  }
  if (/engines\.node|node-version\s*:\s*\d|>=\s*20\.0\.0/i.test(text)) {
    errors.push(`${relativePath}: contains package or CI metadata instead of a support statement`);
  }
}

const workflowRoot = path.join(repositoryRoot, ".github", "workflows");
function parseYamlLists(text) {
  const lines = text.split(/\r?\n/);
  const lists = new Map();
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)([A-Za-z0-9_-]+)\s*:\s*(.*?)(?:\s+#.*)?$/.exec(lines[index]);
    if (!match) continue;
    const baseIndent = match[1].length;
    const key = match[2];
    const inline = match[3].trim();
    if (inline.startsWith("[")) {
      let flowValue = inline;
      let closingLine = index;
      while (!flowValue.includes("]") && closingLine + 1 < lines.length) {
        closingLine += 1;
        flowValue += ` ${lines[closingLine].replace(/\s+#.*$/, "").trim()}`;
      }
      lists.set(
        key,
        flowValue.includes("]")
          ? [
              ...flowValue
                .slice(flowValue.indexOf("[") + 1, flowValue.lastIndexOf("]"))
                .matchAll(/\b(\d{2})\b/g),
            ].map((item) => item[1])
          : [],
      );
      index = closingLine;
      continue;
    }
    if (inline !== "") continue;
    const values = [];
    for (let next = index + 1; next < lines.length; next += 1) {
      const item = /^(\s*)-\s*(.+?)\s*$/.exec(lines[next]);
      if (!item || item[1].length <= baseIndent) break;
      const value = item[2].replace(/\s+#.*$/, "");
      const version = /\b(\d{2})\b/.exec(value)?.[1];
      if (version) values.push(version);
    }
    if (values.length > 0) lists.set(key, values);
  }
  return lists;
}

if (process.argv.includes("--parser-fixture")) {
  const fixture = [
    "strategy:",
    "  matrix:",
    "    node-version: [",
    '      "22",',
    '      "24",',
    '      "26",',
    "    ]",
  ].join("\n");
  if (!hasExactSupportedMatrix(parseYamlLists(fixture).get("node-version") ?? [])) {
    throw new Error("multiline flow-style node-version fixture was not parsed");
  }
  process.stdout.write("Node support YAML parser fixture ok\n");
  process.exit(0);
}

for (const entry of await readdir(workflowRoot, { withFileTypes: true })) {
  if (!entry.isFile() || !/\.ya?ml$/.test(entry.name)) continue;
  const relativePath = `.github/workflows/${entry.name}`;
  const text = await readFile(path.join(repositoryRoot, relativePath), "utf8");
  const matrixLists = parseYamlLists(text);
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const match = /^(\s*)node-version\s*:\s*(.*?)(?:\s+#.*)?$/i.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (value === "") {
      const versions = matrixLists.get("node-version") ?? [];
      if (!hasExactSupportedMatrix(versions)) {
        errors.push(
          `${relativePath}: multiline node-version has no exact supported 22/24/26 declaration`,
        );
      }
      continue;
    }
    const matrixReference = value.match(/\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}/i);
    if (matrixReference) {
      const key = matrixReference[1];
      const versions = matrixLists.get(key) ?? [];
      if (!hasExactSupportedMatrix(versions)) {
        errors.push(
          `${relativePath}: node-version references matrix.${key} without an exact supported 22/24/26 declaration`,
        );
      }
      continue;
    }
    const versions = [...value.matchAll(/\b(\d{2})\b/g)].map((item) => item[1]);
    if (versions.length === 0 || versions.some((version) => !supportedLines.includes(version))) {
      errors.push(`${relativePath}: node-version contains an unsupported line: ${value}`);
    }
  }
  for (const [key, versions] of matrixLists) {
    if (key !== "node-version") continue;
    if (!hasExactSupportedMatrix(versions)) {
      errors.push(
        `${relativePath}: node-version matrix contains an unsupported line: ${versions.join(", ")}`,
      );
    }
  }
  for (const match of text.matchAll(/node-version-file\s*:\s*([^\n#]+)/gi)) {
    const value = match[1].trim().replace(/^['"]|['"]$/g, "");
    if (!value || value.includes("${{")) {
      errors.push(`${relativePath}: node-version-file is not a fixed repository file: ${value}`);
      continue;
    }
    try {
      const fileValue = (await readFile(path.join(repositoryRoot, value), "utf8")).trim();
      if (!supportedLines.includes(fileValue.replace(/^v/, ""))) {
        errors.push(`${relativePath}: node-version-file ${value} declares ${fileValue}`);
      }
    } catch {
      errors.push(`${relativePath}: node-version-file ${value} cannot be read`);
    }
  }
}

const ci = await readFile(path.join(repositoryRoot, ".github/workflows/ci.yml"), "utf8");
if (!/node-version:\s*\[\s*22\s*,\s*24\s*,\s*26\s*\]/.test(ci)) {
  errors.push(".github/workflows/ci.yml: missing the exact 22/24/26 compatibility matrix");
}

const voiceRuntimeBuild = await readFile(
  path.join(repositoryRoot, "packages/voice-runtime/build.mjs"),
  "utf8",
);
const buildTarget = /\btarget\s*:\s*["']node(\d+)["']/.exec(voiceRuntimeBuild)?.[1];
if (buildTarget !== "22") {
  errors.push(
    `packages/voice-runtime/build.mjs: esbuild target must be node22, got ${buildTarget ? `node${buildTarget}` : "missing"}`,
  );
}

try {
  const nvmrc = (await readFile(path.join(repositoryRoot, ".nvmrc"), "utf8")).trim();
  if (!supportedLines.includes(nvmrc.replace(/^v/, ""))) {
    errors.push(`.nvmrc: ${nvmrc} is outside the supported Node lines`);
  }
} catch {
  // .nvmrc is optional; CI and package metadata are authoritative.
}

if (errors.length > 0) {
  throw new Error(`Node support consistency failed:\n${errors.join("\n")}`);
}

process.stdout.write(`Node support consistency ok: ${expectedEngine}\n`);
