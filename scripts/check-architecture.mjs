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
    root: "packages/tracing/src",
    allowed: ["@tvic/core", "@tvic/dal"],
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
    allowed: ["@tvic/core", "@tvic/dal", "@tvic/media", "@tvic/tools", "@tvic/tracing"],
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
    if (entry.isFile() && path.endsWith(".ts") && !path.includes("/dist/")) {
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
