import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const packageRules = [
  {
    root: "packages/core/src",
    allowed: [],
  },
  {
    root: "packages/dal/src",
    allowed: ["@tvic/core"],
  },
  {
    root: "packages/media/src",
    allowed: ["@tvic/core"],
  },
  {
    root: "packages/tools/src",
    allowed: ["@tvic/core"],
  },
  {
    root: "packages/memory/src",
    allowed: ["@tvic/core", "@tvic/dal"],
  },
  {
    root: "packages/providers/src",
    allowed: ["@tvic/core", "@tvic/media"],
  },
  {
    root: "packages/runtime/src",
    allowed: ["@tvic/core", "@tvic/dal", "@tvic/media", "@tvic/tools"],
  },
  // Examples may compose the public packages, but are still checked so they cannot
  // drift into deep/internal imports.
  {
    root: "examples/live-call/src",
    allowed: [
      "@tvic/core",
      "@tvic/dal",
      "@tvic/media",
      "@tvic/providers",
      "@tvic/runtime",
      "@tvic/tools",
    ],
  },
];

const normalizedAudioLiteral =
  /encoding:\s*["']pcm_s16le["'][\s\S]{0,80}sampleRateHz:\s*16000[\s\S]{0,80}channels:\s*1/;

const failures = [];

for (const rule of packageRules) {
  for (const file of await listTypeScriptFiles(rule.root)) {
    const body = await readFile(file, "utf8");
    for (const specifier of importSpecifiers(body)) {
      if (!specifier.startsWith("@tvic/")) {
        continue;
      }
      if (
        !rule.allowed.some(
          (allowed) => specifier === allowed || specifier.startsWith(`${allowed}/`),
        )
      ) {
        failures.push(`${file}: ${specifier} violates package boundary for ${rule.root}`);
      }
    }
  }
}

for (const file of await listTypeScriptFiles("packages")) {
  if (file === "packages/core/src/constants.ts") {
    continue;
  }
  const body = await readFile(file, "utf8");
  if (normalizedAudioLiteral.test(body)) {
    failures.push(`${file}: use PCM16_16K_MONO instead of re-declaring the normalized format`);
  }
}

// --- Trust-boundary + hygiene checks over production source (the packageRules roots) ---
const SRC_ROOTS = packageRules.map((rule) => rule.root);
const DEFAULT_LINE_BUDGET = 900;
// Files over budget but tracked as deferred maintainability debt (not correctness).
const LINE_BUDGET_ALLOWLIST = {
  // The realtime loop is the one remaining deferred split (tracked debt, not correctness).
  "packages/runtime/src/pipeline-loop.ts": 1250,
};
// `JSON.parse(...) as SomeType` trusts disk/network data; `as unknown` (forcing
// validation) is the allowed pattern, so it is excluded.
const jsonParseCast = /JSON\.parse\([^)]*\)\s+as\s+(?!unknown\b)[A-Za-z]/;
const unknownAsCast = /\bas\s+unknown\s+as\b/;
const deepSrcImport = /["']@tvic\/[a-z-]+\/src(?:["']|\/)/;

for (const root of SRC_ROOTS) {
  for (const file of await listTypeScriptFiles(root)) {
    const body = await readFile(file, "utf8");
    const lineCount = body.split("\n").length;
    const budget = LINE_BUDGET_ALLOWLIST[file] ?? DEFAULT_LINE_BUDGET;
    if (lineCount > budget) {
      failures.push(`${file}: ${lineCount} lines exceeds the ${budget}-line budget; split it`);
    }
    if (unknownAsCast.test(body)) {
      failures.push(`${file}: 'as unknown as' escape hatch is not allowed in production source`);
    }
    if (jsonParseCast.test(body)) {
      failures.push(
        `${file}: parse-and-validate JSON.parse(...) instead of casting it to a contract type`,
      );
    }
    if (deepSrcImport.test(body)) {
      failures.push(
        `${file}: deep '@tvic/*/src' import is not allowed; import from the package root`,
      );
    }
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(failure);
  }
  process.exit(1);
}

async function listTypeScriptFiles(root) {
  const files = [];
  await walk(root, files);
  return files;
}

async function walk(dir, files) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(path, files);
      continue;
    }
    if (
      entry.isFile() &&
      (path.endsWith(".ts") || path.endsWith(".tsx")) &&
      !path.includes("/dist/")
    ) {
      files.push(relative(process.cwd(), path));
    }
  }
}

function importSpecifiers(body) {
  const specifiers = [];
  const patterns = [
    /import\s+(?:type\s+)?(?:[^'"]+?\s+from\s+)?["']([^"']+)["']/g,
    /export\s+(?:type\s+)?(?:[^'"]+?\s+from\s+)?["']([^"']+)["']/g,
  ];
  for (const pattern of patterns) {
    for (const match of body.matchAll(pattern)) {
      if (match[1]) {
        specifiers.push(match[1]);
      }
    }
  }
  return specifiers;
}
