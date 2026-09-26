import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { PCM16_16K_MONO, type TtsEvent, type TtsStream } from "../packages/core/dist/index.js";
import {
  createSarvamTtsHttpStreamProvider,
  createSarvamTtsRestProvider,
} from "../packages/providers/dist/index.js";

loadLocalEnv();

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

interface SmokeRecord {
  readonly transport: "rest" | "http-stream";
  readonly status: "passed" | "failed";
  readonly file: string;
  readonly textChars: number;
  readonly audioBytes?: number;
  readonly chunks?: number;
  readonly durationMs?: number;
  readonly error?: string;
}

async function main(): Promise<void> {
  const apiKey = requiredEnv("SARVAM_API_KEY");
  const language = process.env.SARVAM_TTS_LANGUAGE ?? "en-IN";
  const voice = process.env.SARVAM_TTS_VOICE_ID ?? "shubh";
  const text =
    process.env.SARVAM_TTS_TEXT ?? "Hello from TVIC. This is a Sarvam HTTP transport smoke test.";
  const timeoutMs = positiveInteger("SARVAM_TTS_HTTP_SMOKE_TIMEOUT_MS", 30_000);
  const outputRoot = process.env.SARVAM_TTS_HTTP_OUTPUT_DIR?.trim()
    ? resolve(process.env.SARVAM_TTS_HTTP_OUTPUT_DIR)
    : fileURLToPath(new URL("../local/sarvam-tts-http-smoke/", import.meta.url));
  const outputDir = resolve(outputRoot, timestampDirectory());
  mkdirSync(outputDir, { recursive: true });

  const records: SmokeRecord[] = [];
  for (const transport of ["rest", "http-stream"] as const) {
    const file = `${transport}.wav`;
    try {
      const provider =
        transport === "rest"
          ? createSarvamTtsRestProvider({ apiKey, language, voiceId: voice })
          : createSarvamTtsHttpStreamProvider({ apiKey, language, voiceId: voice });
      const stream = await provider.synthesize({
        sessionId: `sarvam_http_smoke_${transport}` as never,
        turnId: `sarvam_http_smoke_${transport}` as never,
        format: PCM16_16K_MONO,
        text,
        stream: true,
      });
      const result = await withTimeout(collectAudio(stream), timeoutMs);
      writeFileSync(resolve(outputDir, file), pcm16ToWav(result.bytes));
      records.push({
        transport,
        status: "passed",
        file,
        textChars: text.length,
        audioBytes: result.bytes.byteLength,
        chunks: result.chunks,
        durationMs: result.durationMs,
      });
      console.log(
        `- ${transport}: passed (${result.chunks} chunks, ${result.bytes.byteLength} PCM bytes, ${result.durationMs}ms)`,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      records.push({ transport, status: "failed", file, textChars: text.length, error: detail });
      console.error(`- ${transport}: failed (${detail})`);
    }
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    provider: "sarvam-tts",
    model: "bulbul:v3",
    language,
    voice,
    format: "pcm_s16le",
    sampleRateHz: PCM16_16K_MONO.sampleRateHz,
    channels: PCM16_16K_MONO.channels,
    records,
  };
  writeFileSync(resolve(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Manifest: ${resolve(outputDir, "manifest.json")}`);
  if (records.some((record) => record.status === "failed")) {
    throw new Error("Sarvam HTTP TTS smoke failed; see manifest.json");
  }
}

interface AudioResult {
  readonly bytes: Uint8Array;
  readonly chunks: number;
  readonly durationMs: number;
}

async function collectAudio(stream: TtsStream): Promise<AudioResult> {
  const chunks: Uint8Array[] = [];
  let committed = 0;
  try {
    for await (const event of stream.events) {
      observeEvent(event, chunks, () => {
        committed += 1;
      });
    }
  } finally {
    if (committed !== 1) await stream.cancel();
  }
  const bytes = concatBytes(chunks);
  if (bytes.byteLength === 0 || bytes.byteLength % 2 !== 0 || committed !== 1) {
    throw new Error(
      `invalid output chunks=${chunks.length}, bytes=${bytes.byteLength}, committed=${committed}`,
    );
  }
  return {
    bytes,
    chunks: chunks.length,
    durationMs: Math.round((bytes.byteLength / 2 / PCM16_16K_MONO.sampleRateHz) * 1_000),
  };
}

function observeEvent(event: TtsEvent, chunks: Uint8Array[], onCommitted: () => void): void {
  if (event.type === "media.audio.chunk") chunks.push(event.audio.bytes);
  if (event.type === "media.audio.committed") onCommitted();
}

function pcm16ToWav(bytes: Uint8Array): Buffer {
  const data = Buffer.from(bytes);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.byteLength, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(PCM16_16K_MONO.sampleRateHz, 24);
  header.writeUInt32LE(PCM16_16K_MONO.sampleRateHz * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.byteLength, 40);
  return Buffer.concat([header, data]);
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`operation timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required env var ${name}`);
  return value;
}

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer`);
  return value;
}

function timestampDirectory(): string {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
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
    if (!match || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = parseEnvValue(match[2] ?? "");
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
