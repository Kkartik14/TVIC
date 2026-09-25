import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { PCM16_16K_MONO } from "../packages/core/dist/index.js";
import {
  SARVAM_TTS_LANGUAGES,
  SARVAM_TTS_VOICES,
  type SarvamTtsLanguage,
  type SarvamTtsVoice,
} from "../packages/providers/dist/index.js";
import { SARVAM_TTS_SAMPLE_TEXT } from "./sarvam-tts-sample-text.js";
import {
  type SarvamHttpAudioResult,
  type SarvamHttpTransport,
  StartPacer,
  delay,
  errorCode,
  errorMessage,
  isCreditExhausted,
  isRetriable,
  loadLocalEnv,
  nonNegativeInteger,
  parseSelection,
  percentile,
  pcm16ToWav,
  positiveInteger,
  requiredEnv,
  synthesizeSarvamHttpAudio,
  timestampDirectory,
} from "./sarvam-tts-http-live-common.js";

interface MatrixJob {
  readonly index: number;
  readonly transport: SarvamHttpTransport;
  readonly voice: SarvamTtsVoice;
  readonly language: SarvamTtsLanguage;
  readonly text: string;
  readonly file: string;
}

interface MatrixRecord {
  readonly index: number;
  readonly transport: SarvamHttpTransport;
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
  readonly errorCode?: string;
  readonly error?: string;
}

interface AttemptResult {
  readonly synthesis: SarvamHttpAudioResult;
  readonly attempts: number;
  readonly latencyMs: number;
}

loadLocalEnv();

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const apiKey = requiredEnv("SARVAM_API_KEY");
  const transports = parseSelection(
    process.env.SARVAM_TTS_HTTP_MATRIX_TRANSPORTS,
    ["rest", "http-stream"],
    "transports",
  ) as SarvamHttpTransport[];
  const voices = parseSelection(
    process.env.SARVAM_TTS_MATRIX_VOICES,
    SARVAM_TTS_VOICES,
    "voices",
  ) as SarvamTtsVoice[];
  const languages = parseSelection(
    process.env.SARVAM_TTS_MATRIX_LANGUAGES,
    SARVAM_TTS_LANGUAGES,
    "languages",
  ) as SarvamTtsLanguage[];
  const concurrency = positiveInteger("SARVAM_TTS_HTTP_MATRIX_CONCURRENCY", 1);
  const retries = nonNegativeInteger("SARVAM_TTS_HTTP_MATRIX_RETRIES", 1);
  const timeoutMs = positiveInteger("SARVAM_TTS_HTTP_MATRIX_TIMEOUT_MS", 45_000);
  const startIntervalMs = positiveInteger("SARVAM_TTS_HTTP_MATRIX_START_INTERVAL_MS", 2_500);
  const retryBaseMs = positiveInteger("SARVAM_TTS_HTTP_MATRIX_RETRY_BASE_MS", 3_000);
  const rateLimitBackoffMs = positiveInteger(
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

  const jobs = createJobs(transports, voices, languages);
  const priorRecords = resumeDir ? readPriorRecords(outputDir) : new Map<string, MatrixRecord>();
  const records: Array<MatrixRecord | undefined> = jobs.map((job) => priorRecords.get(job.file));
  const pacer = new StartPacer(startIntervalMs);
  let nextJob = 0;

  console.log(
    `Sarvam Bulbul v3 HTTP matrix: ${transports.join(" + ")}; ` +
      `${voices.length} voices × ${languages.length} languages × ${transports.length} transports = ${jobs.length} cases`,
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
      if (records[job.index]?.status === "passed") continue;

      try {
        const result = await runWithRetries(
          job,
          apiKey,
          timeoutMs,
          retries,
          retryBaseMs,
          rateLimitBackoffMs,
          pacer,
        );
        if (writeAudio)
          writeFileSync(resolve(outputDir, job.file), pcm16ToWav(result.synthesis.bytes));
        records[job.index] = {
          index: job.index + 1,
          transport: job.transport,
          voice: job.voice,
          language: job.language,
          text: job.text,
          file: job.file,
          status: "passed",
          attempts: result.attempts,
          latencyMs: result.latencyMs,
          chunks: result.synthesis.chunks,
          audioBytes: result.synthesis.bytes.byteLength,
          audioDurationMs: result.synthesis.durationMs,
        };
        console.log(
          `[${job.index + 1}/${jobs.length}] worker=${workerId} ` +
            `${job.transport} ${job.voice}/${job.language}: passed ` +
            `(attempts=${result.attempts}, ${result.latencyMs}ms, ${result.synthesis.durationMs}ms audio)`,
        );
      } catch (error) {
        records[job.index] = {
          index: job.index + 1,
          transport: job.transport,
          voice: job.voice,
          language: job.language,
          text: job.text,
          file: job.file,
          status: "failed",
          attempts: retries + 1,
          errorCode: errorCode(error),
          error: errorMessage(error),
        };
        console.error(
          `[${job.index + 1}/${jobs.length}] worker=${workerId} ` +
            `${job.transport} ${job.voice}/${job.language}: failed (${errorMessage(error)})`,
        );
      }
      writeManifest(
        outputDir,
        transports,
        voices,
        languages,
        concurrency,
        startIntervalMs,
        retries,
        records,
      );
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, jobs.length) }, (_, index) => worker(index + 1)),
  );

  const complete = records.filter((record): record is MatrixRecord => record !== undefined);
  const passed = complete.filter((record) => record.status === "passed");
  const failed = complete.filter((record) => record.status === "failed");
  const summary = {
    total: jobs.length,
    passed: passed.length,
    failed: failed.length,
    byTransport: Object.fromEntries(
      transports.map((transport) => [
        transport,
        summarize(complete.filter((record) => record.transport === transport)),
      ]),
    ),
  };
  writeManifest(
    outputDir,
    transports,
    voices,
    languages,
    concurrency,
    startIntervalMs,
    retries,
    records,
    summary,
  );

  console.log(
    `Sarvam HTTP matrix: ${summary.passed}/${summary.total} passed; ` +
      `REST=${formatTransportSummary(summary.byTransport.rest)} ` +
      `HTTP-stream=${formatTransportSummary(summary.byTransport["http-stream"])}`,
  );
  console.log(`Manifest: ${resolve(outputDir, "manifest.json")}`);
  if (failed.length > 0)
    throw new Error(`${failed.length} matrix case(s) failed; see manifest.json`);
}

function createJobs(
  transports: readonly SarvamHttpTransport[],
  voices: readonly SarvamTtsVoice[],
  languages: readonly SarvamTtsLanguage[],
): MatrixJob[] {
  const jobs: MatrixJob[] = [];
  for (const transport of transports) {
    for (const voice of voices) {
      for (const language of languages) {
        const index = jobs.length;
        jobs.push({
          index,
          transport,
          voice,
          language,
          text: SARVAM_TTS_SAMPLE_TEXT[language],
          file: `${String(index + 1).padStart(4, "0")}-${transport}-${voice}-${language}.wav`,
        });
      }
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
  rateLimitBackoffMs: number,
  pacer: StartPacer,
): Promise<AttemptResult> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    await pacer.wait();
    const startedAt = Date.now();
    try {
      const synthesis = await synthesizeSarvamHttpAudio({
        apiKey,
        transport: job.transport,
        voice: job.voice,
        language: job.language,
        text: job.text,
        sessionId: `sarvam_http_matrix_${job.index}_${job.voice}_${job.language}`,
        turnId: `sarvam_http_matrix_turn_${job.index}`,
        timeoutMs,
      });
      return { synthesis, attempts: attempt, latencyMs: Date.now() - startedAt };
    } catch (error) {
      lastError = error;
      if (attempt > retries || !isRetriable(error) || isCreditExhausted(error)) throw error;
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
  transports: readonly SarvamHttpTransport[],
  voices: readonly SarvamTtsVoice[],
  languages: readonly SarvamTtsLanguage[],
  concurrency: number,
  startIntervalMs: number,
  retries: number,
  records: readonly (MatrixRecord | undefined)[],
  summary?: Readonly<Record<string, unknown>>,
): void {
  writeFileSync(
    resolve(outputDir, "manifest.json"),
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        provider: "sarvam-tts",
        model: "bulbul:v3",
        transports,
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
