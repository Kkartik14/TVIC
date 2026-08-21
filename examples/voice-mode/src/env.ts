import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Loads a local dotenv-style file without overriding deployment-provided values. */
export function loadLocalEnv(
  path = fileURLToPath(new URL("../../../.env", import.meta.url)),
): void {
  if (process.env.NODE_ENV === "production" || process.env.TVIC_ENV === "production") return;
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of source.split(/\r?\n/u)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/u.exec(line);
    if (!match) continue;
    const name = match[1];
    const raw = match[2] ?? "";
    if (!name || process.env[name] !== undefined) continue;
    process.env[name] = parseValue(raw);
  }
}

function parseValue(raw: string): string {
  if (raw.length >= 2) {
    const first = raw[0];
    const last = raw.at(-1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return raw.slice(1, -1);
    }
  }
  const comment = raw.indexOf(" #");
  return comment >= 0 ? raw.slice(0, comment).trimEnd() : raw;
}
