import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

import { createCartesiaSttProvider } from "../packages/providers/dist/index.js";
import { readPcm16Wav } from "../examples/stt-only/src/wav.js";

loadLocalEnv();

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const inputPath = process.argv.slice(2).find((argument) => argument !== "--");
  if (!inputPath) {
    throw new Error("Usage: pnpm cartesia:stt-batch-smoke -- ./speech.wav");
  }
  const apiKey = requiredEnv("CARTESIA_API_KEY");
  const fileBytes = new Uint8Array(await readFile(inputPath));
  const wav = await readPcm16Wav(inputPath);
  const provider = createCartesiaSttProvider({
    apiKey,
    ...(process.env.CARTESIA_STT_BATCH_API_URL
      ? { batchUrl: process.env.CARTESIA_STT_BATCH_API_URL }
      : {}),
    ...(process.env.CARTESIA_STT_BATCH_MODEL
      ? { batchModelId: process.env.CARTESIA_STT_BATCH_MODEL }
      : {}),
  });
  const result = await provider.transcribe({
    audio: fileBytes,
    fileName: basename(inputPath),
    mimeType: "audio/wav",
    language: process.env.CARTESIA_STT_BATCH_LANGUAGE,
    model: process.env.CARTESIA_STT_BATCH_MODEL ?? "ink-whisper",
    timestampGranularities:
      process.env.CARTESIA_STT_BATCH_WORD_TIMESTAMPS === "1" ? ["word"] : undefined,
  });
  console.log(
    `Cartesia batch STT passed: model=${process.env.CARTESIA_STT_BATCH_MODEL ?? "ink-whisper"} ` +
      `audio_ms=${(wav.bytes.byteLength / (wav.format.sampleRateHz * 2)) * 1_000} ` +
      `text_chars=${result.text.length} ` +
      `duration_ms=${result.durationMs ?? "unknown"} ` +
      `words=${result.words?.length ?? 0}`,
  );
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required env var for smoke test: ${name}`);
  return value;
}

function loadLocalEnv(): void {
  if (process.env.NODE_ENV === "production" || process.env.TVIC_ENV === "production") return;
  let source: string;
  try {
    source = readFileSync(fileURLToPath(new URL("../.env", import.meta.url)), "utf8");
  } catch {
    return;
  }
  for (const line of source.split(/\r?\n/u)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/u.exec(line);
    if (!match) continue;
    const name = match[1];
    if (!name || process.env[name] !== undefined) continue;
    process.env[name] = parseEnvValue(match[2] ?? "");
  }
}

function parseEnvValue(raw: string): string {
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
