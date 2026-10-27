import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { PCM16_16K_MONO } from "../packages/core/dist/index.js";
import {
  SARVAM_TTS_LANGUAGES,
  SARVAM_TTS_VOICES,
  type SarvamTtsLanguage,
} from "../packages/providers/dist/index.js";
import { SARVAM_TTS_V4_FLASH_MODEL, SARVAM_TTS_V4_FLASH_VOICES } from "./sarvam-tts-v4-voices.js";
import {
  type SarvamHttpAudioResult,
  type SarvamHttpAudioMetrics,
  type SarvamHttpTransport,
  StartPacer,
  booleanEnv,
  delay,
  errorCode,
  errorMessage,
  loadLocalEnv,
  nonNegativeInteger,
  parseSelection,
  percentile,
  pcm16ToWav,
  requiredEnv,
  synthesizeSarvamHttpAudio,
  timerMilliseconds,
  timestampDirectory,
} from "./sarvam-tts-http-live-common.js";
import {
  isAmbiguousSarvamTtsMatrixOutcome,
  shouldRetrySarvamTtsMatrixError,
} from "./sarvam-tts-matrix-retry.js";
import { acquireSarvamTtsMatrixLock } from "./sarvam-tts-matrix-lock.js";
import {
  recordMatrixArtifactCompletion,
  recordMatrixCompletion,
} from "./sarvam-tts-matrix-checkpoint.js";
import {
  createSarvamTtsHttpMatrixJobs,
  assertSarvamTtsMatrixModel,
  type SarvamTtsHttpMatrixJob,
} from "./sarvam-tts-matrix-jobs.js";
import {
  assertSarvamTtsMatrixNoUnknownRetry,
  carrySarvamTtsMatrixAttemptHistory,
  mergeSarvamTtsMatrixRecordHistory,
  readPriorRecords,
  selectSarvamTtsMatrixRecords,
} from "./sarvam-tts-matrix-resume.js";
import {
  matrixConcurrency,
  writeFileAtomically,
  writeJsonAtomically,
} from "./sarvam-tts-live-limits.js";
import type { SarvamTtsMatrixRecord } from "./sarvam-tts-matrix-resume.js";

type MatrixJob = SarvamTtsHttpMatrixJob;

type MatrixRecord = SarvamTtsMatrixRecord;

interface AttemptResult {
  readonly synthesis: SarvamHttpAudioResult | SarvamHttpAudioMetrics;
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
    process.env.SARVAM_TTS_HTTP_MATRIX_TRANSPORTS,
    ["rest", "http-stream"],
    "transports",
  ) as SarvamHttpTransport[];
  const defaultVoiceCatalog =
    model === SARVAM_TTS_V4_FLASH_MODEL ? SARVAM_TTS_V4_FLASH_VOICES : SARVAM_TTS_VOICES;
  const allowedVoiceCatalog = defaultVoiceCatalog;
  const voices = parseSelection(
    process.env.SARVAM_TTS_MATRIX_VOICES ?? defaultVoiceCatalog.join(","),
    allowedVoiceCatalog,
    "voices",
  );
  const allowedLanguageCatalog = SARVAM_TTS_LANGUAGES;
  const languages = parseSelection(
    process.env.SARVAM_TTS_MATRIX_LANGUAGES ?? SARVAM_TTS_LANGUAGES.join(","),
    allowedLanguageCatalog,
    "languages",
  ) as SarvamTtsLanguage[];
  const concurrency = matrixConcurrency("SARVAM_TTS_HTTP_MATRIX_CONCURRENCY", 1);
  assertSarvamTtsMatrixNoUnknownRetry(booleanEnv("SARVAM_TTS_MATRIX_RETRY_UNKNOWN", false));
  const retries = nonNegativeInteger("SARVAM_TTS_HTTP_MATRIX_RETRIES", 1);
  const timeoutMs = timerMilliseconds("SARVAM_TTS_HTTP_MATRIX_TIMEOUT_MS", 45_000);
  const startIntervalMs = timerMilliseconds("SARVAM_TTS_HTTP_MATRIX_START_INTERVAL_MS", 2_500);
  const retryBaseMs = timerMilliseconds("SARVAM_TTS_HTTP_MATRIX_RETRY_BASE_MS", 3_000);
  const rateLimitBackoffMs = timerMilliseconds(
    "SARVAM_TTS_HTTP_MATRIX_RATE_LIMIT_BACKOFF_MS",
    10_000,
  );
  const writeAudio = process.env.SARVAM_TTS_HTTP_MATRIX_WRITE_AUDIO !== "0";
  const resumeDir = process.env.SARVAM_TTS_HTTP_MATRIX_RESUME_DIR?.trim();
  const outputRoot = process.env.SARVAM_TTS_HTTP_MATRIX_OUTPUT_DIR?.trim()
    ? resolve(process.env.SARVAM_TTS_HTTP_MATRIX_OUTPUT_DIR)
    : fileURLToPath(new URL("../local/sarvam-tts-http-matrix/", import.meta.url));
  const outputDir = resumeDir ? resolve(resumeDir) : resolve(outputRoot, timestampDirectory());
  mkdirSync(outputDir, { recursive: true });
  const releaseMatrixLock = acquireSarvamTtsMatrixLock(outputDir);
  process.once("exit", releaseMatrixLock);

  const jobs = createSarvamTtsHttpMatrixJobs(model, transports, voices, languages);
  const priorRecords = resumeDir
    ? readPriorRecords(outputDir, jobs, writeAudio)
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
      transports,
      voices,
      languages,
      concurrency,
      startIntervalMs,
      retries,
      writeAudio,
      snapshot,
      priorRecords.history,
    );
  const pacer = new StartPacer(startIntervalMs);
  let nextJob = 0;

  console.log(
    `Sarvam ${model} HTTP matrix: ${transports.join(" + ")}; ` +
      `${voices.length} voices × compatible languages × ${transports.length} transports = ${jobs.length} cases`,
  );
  console.log(
    `Concurrency=${concurrency}, startInterval=${startIntervalMs}ms, retries=${retries}, ` +
      `rateLimitBackoff=${rateLimitBackoffMs}ms, writeAudio=${writeAudio}, output=${outputDir}`,
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
          rateLimitBackoffMs,
          pacer,
          (attempt) => {
            const inFlightRecord: MatrixRecord = {
              index: job.index + 1,
              model: job.model,
              transport: job.transport,
              voice: job.voice,
              language: job.language,
              text: job.text,
              file: job.file,
              status: "in_flight",
              attempts: attempt,
              lastRunAttempts: attempt,
              hasAudioArtifact: false,
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
          writeAudio,
        );
        completedAttempts = result.attempts;
        const record: MatrixRecord = {
          index: job.index + 1,
          model: job.model,
          transport: job.transport,
          voice: job.voice,
          language: job.language,
          text: job.text,
          file: job.file,
          status: writeAudio ? "pending" : "passed",
          attempts: result.attempts,
          lastRunAttempts: result.attempts,
          hasAudioArtifact: writeAudio,
          latencyMs: result.latencyMs,
          chunks: result.synthesis.chunks,
          audioBytes: result.synthesis.audioBytes,
          audioDurationMs: result.synthesis.durationMs,
        };
        if (writeAudio) {
          if (!("bytes" in result.synthesis)) {
            throw new Error("matrix audio artifacts require collected synthesis bytes");
          }
          const audioBytes = result.synthesis.bytes;
          const recordWithHistory = previousUnknown
            ? carrySarvamTtsMatrixAttemptHistory(previousUnknown, record)
            : record;
          const passedRecord = { ...recordWithHistory, status: "passed" as const };
          recordMatrixArtifactCompletion(
            records,
            job.index,
            recordWithHistory,
            passedRecord,
            () => writeFileAtomically(resolve(outputDir, job.file), pcm16ToWav(audioBytes)),
            persistRecords,
          );
          completedRecord = passedRecord;
          artifactCheckpointed = true;
        } else {
          completedRecord = previousUnknown
            ? carrySarvamTtsMatrixAttemptHistory(previousUnknown, record)
            : record;
        }
        console.log(
          `[${job.index + 1}/${jobs.length}] worker=${workerId} ` +
            `${job.transport} ${job.voice}/${job.language}: passed ` +
            `(attempts=${result.attempts}, ${result.latencyMs}ms, ${result.synthesis.durationMs}ms audio)`,
        );
      } catch (error) {
        const failure = error instanceof MatrixAttemptError ? error : undefined;
        const cause = failure?.cause ?? error;
        const code = errorCode(cause);
        const outcomeUnknown = failure?.outcomeUnknown ?? isAmbiguousSarvamTtsMatrixOutcome(cause);
        const failedAttemptCount = failure?.attempts ?? completedAttempts ?? retries + 1;
        const failedRecord: MatrixRecord = {
          index: job.index + 1,
          model: job.model,
          transport: job.transport,
          voice: job.voice,
          language: job.language,
          text: job.text,
          file: job.file,
          status: outcomeUnknown ? "unknown" : "failed",
          attempts: failedAttemptCount,
          lastRunAttempts: failedAttemptCount,
          ...(!outcomeUnknown ? { retrySafe: true } : {}),
          error: errorMessage(cause),
          ...(code !== undefined ? { errorCode: code } : {}),
        };
        completedRecord = previousUnknown
          ? carrySarvamTtsMatrixAttemptHistory(previousUnknown, failedRecord)
          : failedRecord;
        console.error(
          `[${job.index + 1}/${jobs.length}] worker=${workerId} ` +
            `${job.transport} ${job.voice}/${job.language}: failed (${errorMessage(cause)})`,
        );
      }
      if (completedRecord && !artifactCheckpointed) {
        recordMatrixCompletion(records, job.index, completedRecord, persistRecords);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, jobs.length) }, (_, index) => worker(index + 1)),
  );

  const complete = records.filter((record): record is MatrixRecord => record !== undefined);
  const passed = complete.filter((record) => record.status === "passed");
  const failed = complete.filter((record) => record.status === "failed");
  const unknown = complete.filter((record) => record.status === "unknown");
  const summary = {
    total: jobs.length,
    passed: passed.length,
    failed: failed.length,
    unknown: unknown.length,
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
    voices,
    languages,
    concurrency,
    startIntervalMs,
    retries,
    writeAudio,
    records,
    priorRecords.history,
    summary,
  );

  console.log(
    `Sarvam HTTP matrix: ${summary.passed}/${summary.total} passed; ` +
      `REST=${formatTransportSummary(summary.byTransport.rest)} ` +
      `HTTP-stream=${formatTransportSummary(summary.byTransport["http-stream"])}`,
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

export async function runWithRetries(
  job: MatrixJob,
  apiKey: string,
  timeoutMs: number,
  retries: number,
  retryBaseMs: number,
  rateLimitBackoffMs: number,
  pacer: StartPacer,
  onAttemptStarted: (attempt: number) => void,
  collectAudio: boolean,
): Promise<AttemptResult> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    await pacer.wait();
    onAttemptStarted(attempt);
    const startedAt = Date.now();
    try {
      const synthesisOptions = {
        apiKey,
        transport: job.transport,
        model: job.model,
        voice: job.voice,
        language: job.language,
        text: job.text,
        sessionId: `sarvam_http_matrix_${job.index}_${job.voice}_${job.language}`,
        turnId: `sarvam_http_matrix_turn_${job.index}`,
        timeoutMs,
      };
      const synthesis = collectAudio
        ? await synthesizeSarvamHttpAudio({ ...synthesisOptions, collectAudio: true })
        : await synthesizeSarvamHttpAudio({ ...synthesisOptions, collectAudio: false });
      return { synthesis, attempts: attempt, latencyMs: Date.now() - startedAt };
    } catch (error) {
      lastError = error;
      if (attempt > retries || !shouldRetrySarvamTtsMatrixError(error)) {
        throw new MatrixAttemptError(error, attempt, isAmbiguousSarvamTtsMatrixOutcome(error));
      }
      const backoffBaseMs =
        errorCode(error) === "provider.rate_limited" ? rateLimitBackoffMs : retryBaseMs;
      await delay(Math.min(120_000, backoffBaseMs * 2 ** (attempt - 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function summarize(records: readonly MatrixRecord[]): Record<string, number> {
  const passed = records.filter((record) => record.status === "passed");
  const latencies = passed
    .map((record) => record.latencyMs ?? 0)
    .sort((left, right) => left - right);
  return {
    total: records.length,
    passed: passed.length,
    failed: records.length - passed.length,
    p50Ms: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
    p99Ms: percentile(latencies, 0.99),
  };
}

function formatTransportSummary(summary: Record<string, number> | undefined): string {
  if (!summary) return "not-run";
  return `${summary.passed}/${summary.total} p50=${summary.p50Ms}ms p99=${summary.p99Ms}ms`;
}

function writeManifest(
  outputDir: string,
  model: string,
  transports: readonly SarvamHttpTransport[],
  voices: readonly string[],
  languages: readonly SarvamTtsLanguage[],
  concurrency: number,
  startIntervalMs: number,
  retries: number,
  writeAudio: boolean,
  records: readonly (MatrixRecord | undefined)[],
  history: readonly MatrixRecord[],
  summary?: Readonly<Record<string, unknown>>,
): void {
  writeJsonAtomically(resolve(outputDir, "manifest.json"), {
    generatedAt: new Date().toISOString(),
    provider: "sarvam-tts",
    model,
    transports,
    format: "pcm_s16le",
    sampleRateHz: PCM16_16K_MONO.sampleRateHz,
    channels: PCM16_16K_MONO.channels,
    voices,
    languages,
    concurrency,
    startIntervalMs,
    retries,
    writeAudio,
    summary,
    records: records.filter((record): record is MatrixRecord => record !== undefined),
    history: mergeSarvamTtsMatrixRecordHistory(history, records),
  });
}
