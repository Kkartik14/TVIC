import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { PCM16_16K_MONO, type TtsEvent } from "../packages/core/dist/index.js";
import {
  SARVAM_TTS_LANGUAGES,
  SARVAM_TTS_VOICES,
  createSarvamTtsProvider,
  type SarvamTtsLanguage,
} from "../packages/providers/dist/index.js";
import {
  isAmbiguousSarvamTtsMatrixOutcome,
  shouldRetrySarvamTtsMatrixError,
} from "./sarvam-tts-matrix-retry.js";
import { acquireSarvamTtsMatrixLock } from "./sarvam-tts-matrix-lock.js";
import {
  assertSarvamTtsMatrixNoUnknownRetry,
  carrySarvamTtsMatrixAttemptHistory,
  mergeSarvamTtsMatrixRecordHistory,
  readPriorLiveRecords,
  selectSarvamTtsMatrixRecords,
} from "./sarvam-tts-matrix-resume.js";
import {
  recordMatrixArtifactCompletion,
  recordMatrixCompletion,
} from "./sarvam-tts-matrix-checkpoint.js";
import {
  createSarvamTtsLiveMatrixJobs,
  assertSarvamTtsMatrixModel,
  type SarvamTtsLiveMatrixJob,
} from "./sarvam-tts-matrix-jobs.js";
import { booleanEnv, pcm16ToWav, timerMilliseconds } from "./sarvam-tts-http-live-common.js";
import {
  matrixConcurrency,
  writeFileAtomically,
  writeJsonAtomically,
} from "./sarvam-tts-live-limits.js";
import {
  SARVAM_TTS_V4_FLASH_MODEL,
  SARVAM_TTS_V4_FLASH_UNVERIFIED_ROSTER_VOICES,
  SARVAM_TTS_V4_FLASH_VOICES,
} from "./sarvam-tts-v4-voices.js";

type MatrixVoice = string;
type MatrixJob = SarvamTtsLiveMatrixJob;

interface MatrixRecord {
  readonly index: number;
  readonly model: string;
  readonly voice: MatrixVoice;
  readonly language: SarvamTtsLanguage;
  readonly text: string;
  readonly file: string;
  readonly status: "in_flight" | "pending" | "passed" | "failed" | "unknown";
  readonly attempts: number;
  readonly retrySafe?: boolean;
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

class MatrixAttemptError extends Error {
  readonly attempts: number;
  readonly outcomeUnknown: boolean;

  constructor(
    override readonly cause: unknown,
    attempts: number,
    outcomeUnknown: boolean,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "MatrixAttemptError";
    this.attempts = attempts;
    this.outcomeUnknown = outcomeUnknown;
  }
}

async function main(): Promise<void> {
  const model = process.env.SARVAM_TTS_MODEL?.trim() || "bulbul:v3";
  assertSarvamTtsMatrixModel(model);
  const apiKey = requiredEnv("SARVAM_API_KEY");
  const defaultVoiceCatalog =
    model === SARVAM_TTS_V4_FLASH_MODEL ? SARVAM_TTS_V4_FLASH_VOICES : SARVAM_TTS_VOICES;
  const allowedVoiceCatalog = defaultVoiceCatalog;
  const voices = parseSelection(
    process.env.SARVAM_TTS_MATRIX_VOICES ?? defaultVoiceCatalog.join(","),
    allowedVoiceCatalog,
    "voices",
  );
  const defaultLanguageCatalog = SARVAM_TTS_LANGUAGES;
  const allowedLanguageCatalog = SARVAM_TTS_LANGUAGES;
  const languages = parseSelection(
    process.env.SARVAM_TTS_MATRIX_LANGUAGES ?? defaultLanguageCatalog.join(","),
    allowedLanguageCatalog,
    "languages",
  );
  const concurrency = matrixConcurrency("SARVAM_TTS_MATRIX_CONCURRENCY", 3);
  assertSarvamTtsMatrixNoUnknownRetry(booleanEnv("SARVAM_TTS_MATRIX_RETRY_UNKNOWN", false));
  const retries = nonNegativeInteger("SARVAM_TTS_MATRIX_RETRIES", 2);
  const timeoutMs = timerMilliseconds("SARVAM_TTS_MATRIX_TIMEOUT_MS", 30_000);
  const startIntervalMs = timerMilliseconds("SARVAM_TTS_MATRIX_START_INTERVAL_MS", 500);
  const retryBaseMs = timerMilliseconds("SARVAM_TTS_MATRIX_RETRY_BASE_MS", 3_000);
  const resumeDir = process.env.SARVAM_TTS_MATRIX_RESUME_DIR?.trim();
  const outputRoot = process.env.SARVAM_TTS_MATRIX_OUTPUT_DIR?.trim()
    ? resolve(process.env.SARVAM_TTS_MATRIX_OUTPUT_DIR)
    : fileURLToPath(new URL("../local/sarvam-tts-matrix/", import.meta.url));
  const outputDir = resumeDir ? resolve(resumeDir) : resolve(outputRoot, timestampDirectory());
  mkdirSync(outputDir, { recursive: true });
  const releaseMatrixLock = acquireSarvamTtsMatrixLock(outputDir);
  process.once("exit", releaseMatrixLock);

  const jobs = createSarvamTtsLiveMatrixJobs(model, voices, languages);
  const priorRecords = resumeDir
    ? readPriorLiveRecords(outputDir, jobs)
    : {
        reusableByFile: new Map<string, MatrixRecord>(),
        unresolvedByFile: new Map<string, MatrixRecord>(),
        history: [],
      };
  const records = selectSarvamTtsMatrixRecords(jobs, priorRecords);
  const persistRecords = (snapshot: readonly (MatrixRecord | undefined)[]): void =>
    writeManifest(
      outputDir,
      model,
      voices,
      languages,
      concurrency,
      startIntervalMs,
      retries,
      snapshot,
      priorRecords.history,
    );
  const pacer = new ConnectionPacer(startIntervalMs);
  let nextJob = 0;

  console.log(
    `Sarvam ${model} live matrix: ${voices.length} voices × compatible languages = ${jobs.length} cases`,
  );
  if (model === SARVAM_TTS_V4_FLASH_MODEL) {
    const excludedUnverifiedRosterVoices = SARVAM_TTS_V4_FLASH_UNVERIFIED_ROSTER_VOICES.filter(
      (voice) => !voices.includes(voice),
    );
    if (excludedUnverifiedRosterVoices.length > 0) {
      console.log(
        `Unverified Assamese roster IDs are not submitted: ${excludedUnverifiedRosterVoices.join(", ")}`,
      );
    }
  }
  console.log(
    `Concurrency=${concurrency}, startInterval=${startIntervalMs}ms, retries=${retries}, output=${outputDir}`,
  );

  async function worker(workerId: number): Promise<void> {
    while (true) {
      const job = jobs[nextJob];
      nextJob += 1;
      if (!job) return;
      if (records[job.index]?.status === "passed" || records[job.index]?.status === "unknown") {
        continue;
      }

      let completedAttempts: number | undefined;
      let completedRecord: MatrixRecord | undefined;
      let artifactCheckpointed = false;
      const previousUnknown = priorRecords.unresolvedByFile.get(job.file);
      try {
        const result = await runWithRetries(
          job,
          apiKey,
          timeoutMs,
          retries,
          retryBaseMs,
          pacer,
          (attempt) => {
            const inFlightRecord: MatrixRecord = {
              index: job.index + 1,
              model: job.model,
              voice: job.voice,
              language: job.language,
              text: job.text,
              file: job.file,
              status: "in_flight",
              attempts: attempt,
              lastRunAttempts: attempt,
            };
            recordMatrixCompletion(
              records,
              job.index,
              previousUnknown
                ? carrySarvamTtsMatrixAttemptHistory(previousUnknown, inFlightRecord)
                : inFlightRecord,
              persistRecords,
            );
          },
        );
        completedAttempts = result.attempts;
        const pendingRecord: MatrixRecord = {
          index: job.index + 1,
          model: job.model,
          voice: job.voice,
          language: job.language,
          text: job.text,
          file: job.file,
          status: "pending",
          attempts: result.attempts,
          lastRunAttempts: result.attempts,
          latencyMs: result.latencyMs,
          chunks: result.synthesis.chunks,
          audioBytes: result.synthesis.bytes.byteLength,
          audioDurationMs: result.synthesis.audioDurationMs,
        };
        const pendingWithHistory = previousUnknown
          ? carrySarvamTtsMatrixAttemptHistory(previousUnknown, pendingRecord)
          : pendingRecord;
        const passedRecord: MatrixRecord = { ...pendingWithHistory, status: "passed" };
        recordMatrixArtifactCompletion(
          records,
          job.index,
          pendingWithHistory,
          passedRecord,
          () =>
            writeFileAtomically(resolve(outputDir, job.file), pcm16ToWav(result.synthesis.bytes)),
          persistRecords,
        );
        completedRecord = passedRecord;
        artifactCheckpointed = true;
        console.log(
          `[${job.index + 1}/${jobs.length}] worker=${workerId} ${job.voice}/${job.language}: passed ` +
            `(attempts=${result.attempts}, ${result.latencyMs}ms, ${result.synthesis.audioDurationMs}ms audio)`,
        );
      } catch (error) {
        const failure = error instanceof MatrixAttemptError ? error : undefined;
        const cause = failure?.cause ?? error;
        const detail = cause instanceof Error ? cause.message : String(cause);
        const outcomeUnknown = failure?.outcomeUnknown ?? isAmbiguousSarvamTtsMatrixOutcome(cause);
        const failedAttemptCount = failure?.attempts ?? completedAttempts ?? retries + 1;
        const failedRecord: MatrixRecord = {
          index: job.index + 1,
          model: job.model,
          voice: job.voice,
          language: job.language,
          text: job.text,
          file: job.file,
          status: outcomeUnknown ? "unknown" : "failed",
          attempts: failedAttemptCount,
          lastRunAttempts: failedAttemptCount,
          ...(!outcomeUnknown ? { retrySafe: true } : {}),
          error: detail,
        };
        completedRecord = previousUnknown
          ? carrySarvamTtsMatrixAttemptHistory(previousUnknown, failedRecord)
          : failedRecord;
        console.error(
          `[${job.index + 1}/${jobs.length}] worker=${workerId} ${job.voice}/${job.language}: failed (${detail})`,
        );
      }
      if (completedRecord && !artifactCheckpointed) {
        recordMatrixCompletion(records, job.index, completedRecord, persistRecords);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, jobs.length) }, (_, i) => worker(i + 1)),
  );

  const complete = records.filter((record): record is MatrixRecord => record !== undefined);
  const passed = complete.filter((record) => record.status === "passed");
  const failed = complete.filter((record) => record.status === "failed");
  const unknown = complete.filter((record) => record.status === "unknown");
  const latencies = passed.map((record) => record.latencyMs ?? 0).sort((a, b) => a - b);
  const summary = {
    total: jobs.length,
    passed: passed.length,
    failed: failed.length,
    unknown: unknown.length,
    p50Ms: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
    p99Ms: percentile(latencies, 0.99),
  };
  writeManifest(
    outputDir,
    model,
    voices,
    languages,
    concurrency,
    startIntervalMs,
    retries,
    records,
    priorRecords.history,
    summary,
  );

  console.log(
    `Sarvam live matrix: ${summary.passed}/${summary.total} passed; ` +
      `p50=${summary.p50Ms}ms p95=${summary.p95Ms}ms p99=${summary.p99Ms}ms`,
  );
  console.log(`Manifest: ${resolve(outputDir, "manifest.json")}`);
  process.off("exit", releaseMatrixLock);
  releaseMatrixLock();
  if (failed.length + unknown.length > 0) {
    throw new Error(
      `${failed.length} matrix case(s) failed and ${unknown.length} have unknown outcomes; ` +
        "inspect manifest.json before retrying unknown cases",
    );
  }
}

async function runWithRetries(
  job: MatrixJob,
  apiKey: string,
  timeoutMs: number,
  retries: number,
  retryBaseMs: number,
  pacer: ConnectionPacer,
  onAttemptStarted: (attempt: number) => void,
): Promise<AttemptResult> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    await pacer.wait();
    onAttemptStarted(attempt);
    const startedAt = Date.now();
    try {
      const synthesis = await synthesize(job, apiKey, timeoutMs);
      return { synthesis, attempts: attempt, latencyMs: Date.now() - startedAt };
    } catch (error) {
      lastError = error;
      if (attempt > retries || !shouldRetrySarvamTtsMatrixError(error)) {
        throw new MatrixAttemptError(error, attempt, isAmbiguousSarvamTtsMatrixOutcome(error));
      }
      await delay(Math.min(30_000, retryBaseMs * 2 ** (attempt - 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function synthesize(
  job: MatrixJob,
  apiKey: string,
  timeoutMs: number,
): Promise<SynthesisResult> {
  const provider = createSarvamTtsProvider({
    apiKey,
    modelId: job.model,
    voiceId: job.voice,
    language: job.language,
  });
  const controller = new AbortController();
  let session: Awaited<ReturnType<typeof provider.openSession>> | undefined;
  let complete = false;
  try {
    return await withTimeout(
      (async () => {
        session = await provider.openSession({
          sessionId: `sarvam_matrix_${job.index}_${job.voice}_${job.language}` as never,
          turnId: `sarvam_matrix_turn_${job.index}` as never,
          voice: job.voice,
          model: job.model,
          format: PCM16_16K_MONO,
          signal: controller.signal,
        });
        await session.sendText(job.text);
        await session.finish();
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
      })(),
      timeoutMs,
      () => controller.abort(),
    );
  } finally {
    if (!complete) {
      controller.abort();
      await session?.cancel().catch(() => undefined);
    }
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
  model: string,
  voices: readonly MatrixVoice[],
  languages: readonly SarvamTtsLanguage[],
  concurrency: number,
  startIntervalMs: number,
  retries: number,
  records: readonly (MatrixRecord | undefined)[],
  history: readonly MatrixRecord[],
  summary?: Readonly<Record<string, number>>,
): void {
  writeJsonAtomically(resolve(outputDir, "manifest.json"), {
    generatedAt: new Date().toISOString(),
    provider: "sarvam-tts",
    model,
    format: "pcm_s16le",
    sampleRateHz: PCM16_16K_MONO.sampleRateHz,
    channels: PCM16_16K_MONO.channels,
    excludedUnverifiedRosterVoices:
      model === SARVAM_TTS_V4_FLASH_MODEL
        ? SARVAM_TTS_V4_FLASH_UNVERIFIED_ROSTER_VOICES.filter((voice) => !voices.includes(voice))
        : [],
    voices,
    languages,
    concurrency,
    startIntervalMs,
    retries,
    summary,
    records: records.filter((record): record is MatrixRecord => record !== undefined),
    history: mergeSarvamTtsMatrixRecordHistory(history, records),
  });
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

function nonNegativeInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > 10)
    throw new Error(`${name} must be a non-negative integer no greater than 10`);
  return value;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          onTimeout?.();
          reject(new Error(`operation timed out after ${timeoutMs}ms`));
        }, timeoutMs);
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadLocalEnv();
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
