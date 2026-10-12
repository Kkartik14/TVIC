import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import {
  type SarvamHttpTransport,
  StartPacer,
  delay,
  errorCode,
  errorMessage,
  loadLocalEnv,
  nonNegativeInteger,
  parseSelection,
  percentile,
  positiveInteger,
  requiredEnv,
  synthesizeSarvamHttpAudio,
  timerMilliseconds,
  timestampDirectory,
} from "./sarvam-tts-http-live-common.js";
import {
  isAmbiguousSarvamTtsMatrixOutcome,
  isRetriable,
  shouldRetrySarvamTtsMatrixError,
} from "./sarvam-tts-matrix-retry.js";
import { writeJsonAtomically } from "./sarvam-tts-live-limits.js";
import { assertSarvamTtsMatrixModel } from "./sarvam-tts-matrix-jobs.js";
import { SARVAM_TTS_V4_FLASH_MODEL } from "./sarvam-tts-v4-voices.js";

interface SoakJob {
  readonly index: number;
  readonly transport: SarvamHttpTransport;
}

interface SoakRecord {
  readonly index: number;
  readonly transport: SarvamHttpTransport;
  readonly status: "passed" | "failed";
  readonly attempts: number;
  readonly latencyMs?: number;
  readonly audioBytes?: number;
  readonly audioDurationMs?: number;
  readonly chunks?: number;
  readonly errorCode?: string;
  readonly error?: string;
  readonly retriable?: boolean;
  readonly outcomeUnknown?: boolean;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadLocalEnv();
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

async function main(): Promise<void> {
  const model = process.env.SARVAM_TTS_MODEL?.trim() || "bulbul:v3";
  assertSarvamTtsMatrixModel(model);
  const apiKey = requiredEnv("SARVAM_API_KEY");
  const transports = parseSelection(
    process.env.SARVAM_TTS_HTTP_SOAK_TRANSPORTS,
    ["rest", "http-stream"],
    "transports",
  ) as SarvamHttpTransport[];
  const samples = positiveInteger("SARVAM_TTS_HTTP_SOAK_SAMPLES", 30, 1_000);
  const concurrency = positiveInteger("SARVAM_TTS_HTTP_SOAK_CONCURRENCY", 2, 32);
  const startIntervalMs = timerMilliseconds("SARVAM_TTS_HTTP_SOAK_START_INTERVAL_MS", 1_000);
  const timeoutMs = timerMilliseconds("SARVAM_TTS_HTTP_SOAK_TIMEOUT_MS", 45_000);
  const retries = nonNegativeInteger("SARVAM_TTS_HTTP_SOAK_RETRIES", 0);
  const retryBaseMs = timerMilliseconds("SARVAM_TTS_HTTP_SOAK_RETRY_BASE_MS", 3_000);
  const voice =
    process.env.SARVAM_TTS_SOAK_VOICE ??
    (model === SARVAM_TTS_V4_FLASH_MODEL ? requiredEnv("SARVAM_TTS_VOICE_ID") : "shubh");
  const language =
    process.env.SARVAM_TTS_SOAK_LANGUAGE?.trim() ||
    (model === SARVAM_TTS_V4_FLASH_MODEL ? requiredEnv("SARVAM_TTS_SOAK_LANGUAGE") : "en-IN");
  const text =
    process.env.SARVAM_TTS_SOAK_TEXT ??
    "This is a bounded Sarvam HTTP transport soak sample for TVIC.";
  const outputRoot = process.env.SARVAM_TTS_HTTP_SOAK_OUTPUT_DIR?.trim()
    ? resolve(process.env.SARVAM_TTS_HTTP_SOAK_OUTPUT_DIR)
    : fileURLToPath(new URL("../local/sarvam-tts-http-soak/", import.meta.url));
  const outputDir = resolve(outputRoot, timestampDirectory());
  mkdirSync(outputDir, { recursive: true });

  const jobs = transports.flatMap((transport) =>
    Array.from({ length: samples }, (_, sampleIndex) => ({
      index: sampleIndex + transports.indexOf(transport) * samples,
      transport,
    })),
  );
  const records: Array<SoakRecord | undefined> = Array.from({ length: jobs.length });
  const pacer = new StartPacer(startIntervalMs);
  const checkpointInterval = Math.max(1, Math.ceil(jobs.length / 20));
  let nextJob = 0;
  let completedSinceCheckpoint = 0;

  console.log(
    `Sarvam HTTP soak: ${samples} samples × ${transports.length} transports = ${jobs.length} calls; ` +
      `model=${model}, voice=${voice}, language=${language}`,
  );
  console.log(
    `Concurrency=${concurrency}, startInterval=${startIntervalMs}ms, retries=${retries}, output=${outputDir}`,
  );

  async function worker(workerId: number): Promise<void> {
    while (true) {
      const job = jobs[nextJob];
      nextJob += 1;
      if (!job) return;
      let completedAttempts: number | undefined;
      try {
        const result = await runWithRetries(
          job,
          apiKey,
          model,
          voice,
          language,
          text,
          timeoutMs,
          retries,
          retryBaseMs,
          pacer,
        );
        completedAttempts = result.attempts;
        records[job.index] = {
          index: job.index + 1,
          transport: job.transport,
          status: "passed",
          attempts: result.attempts,
          latencyMs: result.latencyMs,
          audioBytes: result.audioBytes,
          audioDurationMs: result.audioDurationMs,
          chunks: result.chunks,
        };
        console.log(
          `[${job.index + 1}/${jobs.length}] worker=${workerId} ${job.transport}: passed ` +
            `(attempts=${result.attempts}, ${result.latencyMs}ms, ${result.audioDurationMs}ms audio)`,
        );
      } catch (error) {
        const failure = error instanceof MatrixAttemptError ? error : undefined;
        const cause = failure?.cause ?? error;
        const code = errorCode(cause);
        records[job.index] = {
          index: job.index + 1,
          transport: job.transport,
          status: "failed",
          attempts: failure?.attempts ?? completedAttempts ?? retries + 1,
          error: errorMessage(cause),
          retriable: isRetriable(cause),
          ...(failure?.outcomeUnknown ? { outcomeUnknown: true } : {}),
          ...(code !== undefined ? { errorCode: code } : {}),
        };
        console.error(
          `[${job.index + 1}/${jobs.length}] worker=${workerId} ${job.transport}: failed ` +
            `(${errorCode(cause) ?? "unknown"}: ${errorMessage(cause)})`,
        );
      }
      completedSinceCheckpoint += 1;
      if (completedSinceCheckpoint >= checkpointInterval) {
        writeManifest(
          outputDir,
          model,
          transports,
          samples,
          concurrency,
          startIntervalMs,
          retries,
          voice,
          language,
          text,
          records,
        );
        completedSinceCheckpoint = 0;
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, jobs.length) }, (_, index) => worker(index + 1)),
  );

  const complete = records.filter((record): record is SoakRecord => record !== undefined);
  const summary = {
    total: complete.length,
    passed: complete.filter((record) => record.status === "passed").length,
    failed: complete.filter((record) => record.status === "failed").length,
    byTransport: Object.fromEntries(
      transports.map((transport) => [
        transport,
        summarize(complete.filter((record) => record.transport === transport)),
      ]),
    ),
  };
  writeManifest(
    outputDir,
    model,
    transports,
    samples,
    concurrency,
    startIntervalMs,
    retries,
    voice,
    language,
    text,
    records,
    summary,
  );

  console.log(
    `Sarvam HTTP soak: ${summary.passed}/${summary.total} passed; ` +
      transports
        .map((transport) => `${transport}=${formatSummary(summary.byTransport[transport])}`)
        .join(" "),
  );
  console.log(`Manifest: ${resolve(outputDir, "manifest.json")}`);
  if (summary.failed > 0)
    throw new Error(`${summary.failed} soak call(s) failed; see manifest.json`);
}

interface AttemptResult {
  readonly attempts: number;
  readonly latencyMs: number;
  readonly audioBytes: number;
  readonly audioDurationMs: number;
  readonly chunks: number;
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

async function runWithRetries(
  job: SoakJob,
  apiKey: string,
  model: string,
  voice: string,
  language: string,
  text: string,
  timeoutMs: number,
  retries: number,
  retryBaseMs: number,
  pacer: StartPacer,
): Promise<AttemptResult> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    await pacer.wait();
    const startedAt = Date.now();
    try {
      const result = await synthesizeSarvamHttpAudio({
        apiKey,
        transport: job.transport,
        model,
        voice,
        language,
        text,
        sessionId: `sarvam_http_soak_${job.index}_${attempt}`,
        turnId: `sarvam_http_soak_turn_${job.index}_${attempt}`,
        timeoutMs,
        collectAudio: false,
      });
      return {
        attempts: attempt,
        latencyMs: Date.now() - startedAt,
        audioBytes: result.audioBytes,
        audioDurationMs: result.durationMs,
        chunks: result.chunks,
      };
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

function summarize(records: readonly SoakRecord[]): Record<string, unknown> {
  const passed = records.filter((record) => record.status === "passed");
  const latencies = passed
    .map((record) => record.latencyMs ?? 0)
    .sort((left, right) => left - right);
  const errors = Object.fromEntries(
    Object.entries(
      passed.length === records.length
        ? {}
        : records
            .filter((record) => record.status === "failed")
            .reduce<Record<string, number>>((counts, record) => {
              const key = record.errorCode ?? "unknown";
              counts[key] = (counts[key] ?? 0) + 1;
              return counts;
            }, {}),
    ),
  );
  return {
    total: records.length,
    passed: passed.length,
    failed: records.length - passed.length,
    p50Ms: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
    p99Ms: percentile(latencies, 0.99),
    minMs: latencies[0] ?? 0,
    maxMs: latencies.at(-1) ?? 0,
    errors,
  };
}

function formatSummary(summary: Record<string, unknown> | undefined): string {
  if (!summary) return "not-run";
  return (
    `${String(summary.passed)}/${String(summary.total)} ` +
    `p50=${String(summary.p50Ms)}ms p95=${String(summary.p95Ms)}ms p99=${String(summary.p99Ms)}ms`
  );
}

function writeManifest(
  outputDir: string,
  model: string,
  transports: readonly SarvamHttpTransport[],
  samples: number,
  concurrency: number,
  startIntervalMs: number,
  retries: number,
  voice: string,
  language: string,
  text: string,
  records: readonly (SoakRecord | undefined)[],
  summary?: Readonly<Record<string, unknown>>,
): void {
  writeJsonAtomically(resolve(outputDir, "manifest.json"), {
    generatedAt: new Date().toISOString(),
    provider: "sarvam-tts",
    model,
    transports,
    samplesPerTransport: samples,
    voice,
    language,
    text,
    concurrency,
    startIntervalMs,
    retries,
    summary,
    records: records.filter((record): record is SoakRecord => record !== undefined),
  });
}
