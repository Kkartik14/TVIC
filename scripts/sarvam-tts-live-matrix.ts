import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { PCM16_16K_MONO, type TtsEvent } from "../packages/core/dist/index.js";
import {
  SARVAM_TTS_LANGUAGES,
  SARVAM_TTS_VOICES,
  createSarvamTtsProvider,
  type SarvamTtsLanguage,
  type SarvamTtsVoice,
} from "../packages/providers/dist/index.js";
import { SARVAM_TTS_SAMPLE_TEXT } from "./sarvam-tts-sample-text.js";

interface MatrixJob {
  readonly index: number;
  readonly voice: SarvamTtsVoice;
  readonly language: SarvamTtsLanguage;
  readonly text: string;
  readonly file: string;
}

interface MatrixRecord {
  readonly index: number;
  readonly voice: SarvamTtsVoice;
  readonly language: SarvamTtsLanguage;
  readonly text: string;
  readonly file: string;
  readonly status: "passed" | "failed";
  readonly attempts: number;
  readonly latencyMs?: number;
  readonly chunks?: number;
  readonly audioBytes?: number;
  readonly audioDurationMs?: number;
  readonly error?: string;
}

interface SynthesisResult {
  readonly bytes: Uint8Array;
  readonly chunks: number;
  readonly audioDurationMs: number;
}

interface AttemptResult {
  readonly synthesis: SynthesisResult;
  readonly attempts: number;
  readonly latencyMs: number;
}

async function main(): Promise<void> {
  const apiKey = requiredEnv("SARVAM_API_KEY");
  const voices = parseSelection(process.env.SARVAM_TTS_MATRIX_VOICES, SARVAM_TTS_VOICES, "voices");
  const languages = parseSelection(
    process.env.SARVAM_TTS_MATRIX_LANGUAGES,
    SARVAM_TTS_LANGUAGES,
    "languages",
  );
  const concurrency = positiveInteger("SARVAM_TTS_MATRIX_CONCURRENCY", 3);
  const retries = nonNegativeInteger("SARVAM_TTS_MATRIX_RETRIES", 2);
  const timeoutMs = positiveInteger("SARVAM_TTS_MATRIX_TIMEOUT_MS", 30_000);
  const startIntervalMs = positiveInteger("SARVAM_TTS_MATRIX_START_INTERVAL_MS", 500);
  const retryBaseMs = positiveInteger("SARVAM_TTS_MATRIX_RETRY_BASE_MS", 3_000);
  const resumeDir = process.env.SARVAM_TTS_MATRIX_RESUME_DIR?.trim();
  const outputRoot = process.env.SARVAM_TTS_MATRIX_OUTPUT_DIR?.trim()
    ? resolve(process.env.SARVAM_TTS_MATRIX_OUTPUT_DIR)
    : fileURLToPath(new URL("../local/sarvam-tts-matrix/", import.meta.url));
  const outputDir = resumeDir ? resolve(resumeDir) : resolve(outputRoot, timestampDirectory());
  mkdirSync(outputDir, { recursive: true });

  const jobs = createJobs(voices, languages);
  const priorRecords = resumeDir ? readPriorRecords(outputDir) : new Map<string, MatrixRecord>();
  const records: Array<MatrixRecord | undefined> = jobs.map((job) => priorRecords.get(job.file));
  const pacer = new ConnectionPacer(startIntervalMs);
  let nextJob = 0;

  console.log(
    `Sarvam Bulbul v3 live matrix: ${voices.length} voices × ${languages.length} languages = ${jobs.length} cases`,
  );
  console.log(
    `Concurrency=${concurrency}, startInterval=${startIntervalMs}ms, retries=${retries}, output=${outputDir}`,
  );

  async function worker(workerId: number): Promise<void> {
    while (true) {
      const job = jobs[nextJob];
      nextJob += 1;
      if (!job) return;
      if (records[job.index]?.status === "passed") {
        continue;
      }

      try {
        const result = await runWithRetries(job, apiKey, timeoutMs, retries, retryBaseMs, pacer);
        writeFileSync(resolve(outputDir, job.file), pcm16ToWav(result.synthesis.bytes));
        records[job.index] = {
          index: job.index + 1,
          voice: job.voice,
          language: job.language,
          text: job.text,
          file: job.file,
          status: "passed",
          attempts: result.attempts,
          latencyMs: result.latencyMs,
          chunks: result.synthesis.chunks,
          audioBytes: result.synthesis.bytes.byteLength,
          audioDurationMs: result.synthesis.audioDurationMs,
        };
        console.log(
          `[${job.index + 1}/${jobs.length}] worker=${workerId} ${job.voice}/${job.language}: passed ` +
            `(attempts=${result.attempts}, ${result.latencyMs}ms, ${result.synthesis.audioDurationMs}ms audio)`,
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        records[job.index] = {
          index: job.index + 1,
          voice: job.voice,
          language: job.language,
          text: job.text,
          file: job.file,
          status: "failed",
          attempts: retries + 1,
          error: detail,
        };
        console.error(
          `[${job.index + 1}/${jobs.length}] worker=${workerId} ${job.voice}/${job.language}: failed (${detail})`,
        );
      }
      writeManifest(outputDir, voices, languages, concurrency, startIntervalMs, retries, records);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, jobs.length) }, (_, i) => worker(i + 1)),
  );

  const complete = records.filter((record): record is MatrixRecord => record !== undefined);
  const passed = complete.filter((record) => record.status === "passed");
  const failed = complete.filter((record) => record.status === "failed");
  const latencies = passed.map((record) => record.latencyMs ?? 0).sort((a, b) => a - b);
  const summary = {
    total: jobs.length,
    passed: passed.length,
    failed: failed.length,
    p50Ms: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
    p99Ms: percentile(latencies, 0.99),
  };
  writeManifest(
    outputDir,
    voices,
    languages,
    concurrency,
    startIntervalMs,
    retries,
    records,
    summary,
  );

  console.log(
    `Sarvam live matrix: ${summary.passed}/${summary.total} passed; ` +
      `p50=${summary.p50Ms}ms p95=${summary.p95Ms}ms p99=${summary.p99Ms}ms`,
  );
  console.log(`Manifest: ${resolve(outputDir, "manifest.json")}`);
  if (failed.length > 0)
    throw new Error(`${failed.length} matrix case(s) failed; see manifest.json`);
}

function createJobs(
  voices: readonly SarvamTtsVoice[],
  languages: readonly SarvamTtsLanguage[],
): MatrixJob[] {
  const jobs: MatrixJob[] = [];
  for (const voice of voices) {
    for (const language of languages) {
      const index = jobs.length;
      jobs.push({
        index,
        voice,
        language,
        text: SARVAM_TTS_SAMPLE_TEXT[language],
        file: `${String(index + 1).padStart(3, "0")}-${voice}-${language}.wav`,
      });
    }
  }
  return jobs;
}

async function runWithRetries(
  job: MatrixJob,
  apiKey: string,
  timeoutMs: number,
  retries: number,
  retryBaseMs: number,
  pacer: ConnectionPacer,
): Promise<AttemptResult> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    const startedAt = Date.now();
    try {
      const synthesis = await synthesize(job, apiKey, timeoutMs, pacer);
      return { synthesis, attempts: attempt, latencyMs: Date.now() - startedAt };
    } catch (error) {
      lastError = error;
      if (attempt > retries || !isRetriable(error)) throw error;
      await delay(Math.min(30_000, retryBaseMs * 2 ** (attempt - 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function synthesize(
  job: MatrixJob,
  apiKey: string,
  timeoutMs: number,
  pacer: ConnectionPacer,
): Promise<SynthesisResult> {
  const provider = createSarvamTtsProvider({
    apiKey,
    voiceId: job.voice,
    language: job.language,
  });
  await pacer.wait();
  const session = await provider.openSession({
    sessionId: `sarvam_matrix_${job.index}_${job.voice}_${job.language}` as never,
    turnId: `sarvam_matrix_turn_${job.index}` as never,
    voice: job.voice,
    format: PCM16_16K_MONO,
  });
  let complete = false;
  try {
    await session.sendText(job.text);
    await withTimeout(session.finish(), timeoutMs);
    const chunks: Uint8Array[] = [];
    let committed = 0;
    for await (const event of session.events) {
      observeTtsEvent(
        event,
        (bytes) => chunks.push(bytes),
        () => {
          committed += 1;
        },
      );
    }
    const audio = concatBytes(chunks);
    if (audio.byteLength === 0 || audio.byteLength % 2 !== 0 || committed !== 1) {
      throw new Error(
        `invalid output chunks=${chunks.length}, bytes=${audio.byteLength}, committed=${committed}`,
      );
    }
    complete = true;
    return {
      bytes: audio,
      chunks: chunks.length,
      audioDurationMs: Math.round((audio.byteLength / 2 / PCM16_16K_MONO.sampleRateHz) * 1_000),
    };
  } finally {
    if (!complete) await session.cancel().catch(() => undefined);
  }
}

function observeTtsEvent(
  event: TtsEvent,
  onAudio: (bytes: Uint8Array) => void,
  onCommitted: () => void,
): void {
  if (event.type === "media.audio.chunk") onAudio(event.audio.bytes);
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

function writeManifest(
  outputDir: string,
  voices: readonly SarvamTtsVoice[],
  languages: readonly SarvamTtsLanguage[],
  concurrency: number,
  startIntervalMs: number,
  retries: number,
  records: readonly (MatrixRecord | undefined)[],
  summary?: Readonly<Record<string, number>>,
): void {
  writeFileSync(
    resolve(outputDir, "manifest.json"),
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        provider: "sarvam-tts",
        model: "bulbul:v3",
        format: "pcm_s16le",
        sampleRateHz: PCM16_16K_MONO.sampleRateHz,
        channels: PCM16_16K_MONO.channels,
        voices,
        languages,
        concurrency,
        startIntervalMs,
        retries,
        summary,
        records: records.filter((record): record is MatrixRecord => record !== undefined),
      },
      null,
      2,
    )}\n`,
  );
}

function readPriorRecords(outputDir: string): Map<string, MatrixRecord> {
  try {
    const manifest = JSON.parse(readFileSync(resolve(outputDir, "manifest.json"), "utf8")) as {
      records?: MatrixRecord[];
    };
    return new Map(
      (manifest.records ?? [])
        .filter((record) => typeof record?.file === "string")
        .map((record) => [record.file, record]),
    );
  } catch {
    throw new Error(`cannot resume matrix: missing or invalid manifest in ${outputDir}`);
  }
}

class ConnectionPacer {
  #tail: Promise<void> = Promise.resolve();
  #nextAllowedAt = 0;

  constructor(readonly intervalMs: number) {}

  async wait(): Promise<void> {
    const previous = this.#tail;
    let release: () => void = () => undefined;
    this.#tail = new Promise<void>((resolveRelease) => {
      release = resolveRelease;
    });
    await previous;
    try {
      const waitMs = Math.max(0, this.#nextAllowedAt - Date.now());
      if (waitMs > 0) await delay(waitMs);
      this.#nextAllowedAt = Date.now() + this.intervalMs;
    } finally {
      release();
    }
  }
}

function percentile(values: readonly number[], ratio: number): number {
  if (values.length === 0) return 0;
  return (
    values[Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * ratio) - 1))] ?? 0
  );
}

function isRetriable(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "retriable" in error) {
    return (error as { retriable?: unknown }).retriable === true;
  }
  return false;
}

function parseSelection<T extends readonly string[]>(
  raw: string | undefined,
  allowed: T,
  name: string,
): T[number][] {
  const values = (raw ?? allowed.join(","))
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.length === 0) throw new Error(`${name} selection cannot be empty`);
  for (const value of values) {
    if (!allowed.includes(value)) throw new Error(`unsupported ${name} entry: ${value}`);
  }
  if (new Set(values).size !== values.length)
    throw new Error(`${name} selection contains duplicates`);
  return values as T[number][];
}

function timestampDirectory(): string {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function nonNegativeInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0)
    throw new Error(`${name} must be a non-negative integer`);
  return value;
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

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required env var ${name}`);
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

loadLocalEnv();

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
