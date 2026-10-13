import { basename, resolve } from "node:path";

import { hasValidPcm16Wav, type SarvamHttpTransport } from "./sarvam-tts-http-live-common.js";
import { createSarvamTtsMatrixArtifactFile } from "./sarvam-tts-matrix-jobs.js";
import { MAX_MATRIX_MANIFEST_BYTES, readBoundedJson } from "./sarvam-tts-live-limits.js";

export interface SarvamTtsMatrixJobIdentity {
  readonly index: number;
  readonly model: string;
  readonly transport: SarvamHttpTransport;
  readonly voice: string;
  readonly language: string;
  readonly text: string;
  readonly file: string;
}

export interface SarvamTtsMatrixRecord extends SarvamTtsMatrixJobIdentity {
  readonly status: "in_flight" | "pending" | "passed" | "failed" | "unknown";
  readonly attempts: number;
  readonly lastRunAttempts?: number;
  readonly priorUnknownAttempts?: number;
  readonly priorUnknownError?: string;
  readonly retrySafe?: boolean;
  readonly hasAudioArtifact?: boolean;
  readonly latencyMs?: number;
  readonly chunks?: number;
  readonly audioBytes?: number;
  readonly audioDurationMs?: number;
  readonly errorCode?: string;
  readonly error?: string;
}

export interface SarvamTtsLiveMatrixJobIdentity {
  readonly index: number;
  readonly model: string;
  readonly voice: string;
  readonly language: string;
  readonly text: string;
  readonly file: string;
}

export interface SarvamTtsLiveMatrixRecord extends SarvamTtsLiveMatrixJobIdentity {
  readonly status: "in_flight" | "pending" | "passed" | "failed" | "unknown";
  readonly attempts: number;
  readonly lastRunAttempts?: number;
  readonly priorUnknownAttempts?: number;
  readonly priorUnknownError?: string;
  readonly retrySafe?: boolean;
  readonly latencyMs?: number;
  readonly chunks?: number;
  readonly audioBytes?: number;
  readonly audioDurationMs?: number;
  readonly error?: string;
}

export interface SarvamTtsMatrixResumeState<T> {
  readonly reusableByFile: ReadonlyMap<string, T>;
  readonly unresolvedByFile: ReadonlyMap<string, T>;
  readonly history: readonly T[];
}

export function assertSarvamTtsMatrixNoUnknownRetry(retryUnknown: boolean): void {
  if (retryUnknown) {
    throw new Error(
      "Ambiguous Sarvam TTS outcomes are never replayed automatically; review the manifest before retrying.",
    );
  }
}

export function selectSarvamTtsMatrixRecords<TJob extends { readonly file: string }, TRecord>(
  jobs: readonly TJob[],
  state: SarvamTtsMatrixResumeState<TRecord>,
): Array<TRecord | undefined> {
  return jobs.map(
    (job) => state.reusableByFile.get(job.file) ?? state.unresolvedByFile.get(job.file),
  );
}

export function carrySarvamTtsMatrixAttemptHistory<
  T extends {
    readonly status: string;
    readonly attempts: number;
    readonly lastRunAttempts?: number;
    readonly priorUnknownAttempts?: number;
    readonly priorUnknownError?: string;
    readonly error?: string;
  },
>(previous: T, current: T): T {
  const priorUnknownAttempts =
    (previous.priorUnknownAttempts ?? 0) +
    (previous.status === "unknown" ? (previous.lastRunAttempts ?? previous.attempts) : 0);
  const priorUnknownError =
    previous.status === "unknown" ? previous.error : previous.priorUnknownError;
  const result: Record<string, unknown> = {
    ...current,
    attempts: previous.attempts + current.attempts,
    lastRunAttempts: current.attempts,
    ...(priorUnknownAttempts > 0 ? { priorUnknownAttempts } : {}),
    ...(priorUnknownError !== undefined ? { priorUnknownError } : {}),
  };
  if (previous.status === "unknown" && current.status === "failed") {
    result.status = "unknown";
    delete result.retrySafe;
  }
  return result as T;
}

export function readPriorLiveRecords(
  outputDir: string,
  jobs: readonly SarvamTtsLiveMatrixJobIdentity[],
): SarvamTtsMatrixResumeState<SarvamTtsLiveMatrixRecord> {
  const manifest = readSarvamMatrixManifest(outputDir);
  const values = manifestRecordValues(manifest, outputDir);
  assertNoLegacySarvamMatrixRecords(manifest, values, outputDir);
  const historyByFile = new Map<string, SarvamTtsLiveMatrixRecord>();
  for (const value of values) {
    const record = normalizeLiveRecord(value, outputDir);
    if (!record) {
      throw new Error(`cannot resume matrix: invalid Sarvam TTS manifest record in ${outputDir}`);
    }
    historyByFile.set(record.file, record);
  }

  const jobsByIdentity = new Map<string, SarvamTtsLiveMatrixJobIdentity>();
  for (const job of jobs) {
    const identity = liveIdentityKey(job);
    if (identity !== undefined) jobsByIdentity.set(identity, job);
  }
  const reusableByFile = new Map<string, SarvamTtsLiveMatrixRecord>();
  const unresolvedByFile = new Map<string, SarvamTtsLiveMatrixRecord>();
  for (const record of historyByFile.values()) {
    const job = jobsByIdentity.get(liveIdentityKey(record) ?? "");
    if (!job || record.file !== job.file) continue;
    if (record.status === "passed") {
      reusableByFile.set(job.file, { ...record, index: job.index + 1 });
    } else if (
      record.status === "unknown" ||
      (record.status === "failed" && record.retrySafe === true)
    ) {
      unresolvedByFile.set(job.file, { ...record, index: job.index + 1 });
    }
  }
  return { reusableByFile, unresolvedByFile, history: [...historyByFile.values()] };
}

export function readPriorRecords(
  outputDir: string,
  jobs: readonly SarvamTtsMatrixJobIdentity[],
  writeAudio: boolean,
): SarvamTtsMatrixResumeState<SarvamTtsMatrixRecord> {
  const manifest = readSarvamMatrixManifest(outputDir);
  if (manifest.writeAudio !== undefined && typeof manifest.writeAudio !== "boolean") {
    throw new Error(`cannot resume matrix: invalid Sarvam TTS manifest in ${outputDir}`);
  }

  const values = manifestRecordValues(manifest, outputDir);
  assertNoLegacySarvamMatrixRecords(manifest, values, outputDir);
  const historyByFile = new Map<string, SarvamTtsMatrixRecord>();
  for (const value of values) {
    const record = normalizeHttpRecord(value, outputDir, manifest.writeAudio !== false);
    if (!record) {
      throw new Error(`cannot resume matrix: invalid Sarvam TTS manifest record in ${outputDir}`);
    }
    historyByFile.set(record.file, record);
  }

  const jobsByIdentity = new Map<string, SarvamTtsMatrixJobIdentity>();
  for (const job of jobs) {
    const identity = httpIdentityKey(job);
    if (identity !== undefined) jobsByIdentity.set(identity, job);
  }
  const reusableByFile = new Map<string, SarvamTtsMatrixRecord>();
  const unresolvedByFile = new Map<string, SarvamTtsMatrixRecord>();
  for (const record of historyByFile.values()) {
    const job = jobsByIdentity.get(httpIdentityKey(record) ?? "");
    if (!job || record.file !== job.file) continue;
    if (record.status === "passed") {
      if (!writeAudio || record.hasAudioArtifact) {
        reusableByFile.set(job.file, { ...record, index: job.index + 1 });
      } else {
        unresolvedByFile.set(job.file, {
          ...record,
          index: job.index + 1,
          status: "unknown",
          error: "prior synthesis completed without a WAV artifact; inspect before retrying",
        });
      }
    } else if (
      record.status === "unknown" ||
      (record.status === "failed" && record.retrySafe === true)
    ) {
      unresolvedByFile.set(job.file, { ...record, index: job.index + 1 });
    }
  }
  return { reusableByFile, unresolvedByFile, history: [...historyByFile.values()] };
}

export function mergeSarvamTtsMatrixRecordHistory<T extends { readonly file: string }>(
  history: readonly T[],
  records: readonly (T | undefined)[],
): T[] {
  const merged = new Map<string, T>();
  for (const record of history) merged.set(record.file, record);
  for (const record of records) {
    if (record) merged.set(record.file, record);
  }
  return [...merged.values()];
}

function readSarvamMatrixManifest(
  outputDir: string,
): Record<string, unknown> & { readonly records: readonly unknown[] } {
  let manifest: unknown;
  try {
    manifest = readBoundedJson<unknown>(
      resolve(outputDir, "manifest.json"),
      MAX_MATRIX_MANIFEST_BYTES,
    );
  } catch {
    throw new Error(`cannot resume matrix: missing or invalid manifest in ${outputDir}`);
  }

  if (!isSarvamMatrixManifest(manifest)) {
    throw new Error(`cannot resume matrix: invalid Sarvam TTS manifest in ${outputDir}`);
  }
  return manifest;
}

function isSarvamMatrixManifest(
  value: unknown,
): value is Record<string, unknown> & { readonly records: readonly unknown[] } {
  return isRecord(value) && value.provider === "sarvam-tts" && Array.isArray(value.records);
}

function manifestRecordValues(
  manifest: Record<string, unknown> & { readonly records: readonly unknown[] },
  outputDir: string,
): readonly unknown[] {
  if (manifest.history !== undefined && !Array.isArray(manifest.history)) {
    throw new Error(`cannot resume matrix: invalid Sarvam TTS manifest in ${outputDir}`);
  }
  return [...(Array.isArray(manifest.history) ? manifest.history : []), ...manifest.records];
}

function assertNoLegacySarvamMatrixRecords(
  manifest: Record<string, unknown>,
  values: readonly unknown[],
  outputDir: string,
): void {
  if (typeof manifest.model !== "string") return;
  const hasLegacyRecord = values.some((value) => {
    if (
      !isRecord(value) ||
      typeof value.model === "string" ||
      !isPositiveSafeInteger(value.index) ||
      typeof value.voice !== "string" ||
      typeof value.language !== "string" ||
      typeof value.text !== "string" ||
      typeof value.file !== "string" ||
      (value.status !== "passed" && value.status !== "failed")
    ) {
      return false;
    }
    const indexPrefix = String(value.index).padStart(
      value.transport === "rest" || value.transport === "http-stream" ? 4 : 3,
      "0",
    );
    return value.file.startsWith(`${indexPrefix}-`);
  });
  if (hasLegacyRecord) {
    throw new Error(
      `cannot resume matrix: legacy Sarvam TTS matrix manifest in ${outputDir}; ` +
        "use the matching older runner or migrate its artifacts before resuming",
    );
  }
}

function attemptHistoryFields(value: Record<string, unknown>): {
  readonly lastRunAttempts?: number;
  readonly priorUnknownAttempts?: number;
  readonly priorUnknownError?: string;
} {
  return {
    ...(isPositiveSafeInteger(value.lastRunAttempts)
      ? { lastRunAttempts: value.lastRunAttempts }
      : {}),
    ...(isNonNegativeSafeInteger(value.priorUnknownAttempts) && value.priorUnknownAttempts > 0
      ? { priorUnknownAttempts: value.priorUnknownAttempts }
      : {}),
    ...(typeof value.priorUnknownError === "string"
      ? { priorUnknownError: value.priorUnknownError }
      : {}),
  };
}

function normalizeLiveRecord(
  value: unknown,
  outputDir: string,
): SarvamTtsLiveMatrixRecord | undefined {
  if (
    !isRecord(value) ||
    (value.status !== "in_flight" &&
      value.status !== "unknown" &&
      value.status !== "passed" &&
      value.status !== "pending" &&
      value.status !== "failed") ||
    !isSafeArtifactFile(value.file) ||
    !hasLiveIdentity(value)
  ) {
    return undefined;
  }
  if (
    !isPositiveSafeInteger(value.index) ||
    !isPositiveSafeInteger(value.attempts) ||
    value.file !==
      createSarvamTtsMatrixArtifactFile(value.model, value.voice, value.language, value.text)
  ) {
    return undefined;
  }

  if (value.status === "in_flight") {
    if (!isPositiveSafeInteger(value.attempts)) return undefined;
    return {
      index: value.index,
      model: value.model,
      voice: value.voice,
      language: value.language,
      text: value.text,
      file: value.file,
      status: "unknown",
      attempts: value.attempts,
      ...attemptHistoryFields(value),
      error: "matrix stopped during an API attempt; inspect the outcome before retrying",
    };
  }
  if (value.status === "unknown") {
    if (!isPositiveSafeInteger(value.attempts) || typeof value.error !== "string") return undefined;
    return {
      index: value.index,
      model: value.model,
      voice: value.voice,
      language: value.language,
      text: value.text,
      file: value.file,
      status: "unknown",
      attempts: value.attempts,
      ...attemptHistoryFields(value),
      error: value.error,
    };
  }

  if (value.status === "failed") {
    if (typeof value.error !== "string" || !isPositiveSafeInteger(value.attempts)) return undefined;
    return {
      index: value.index,
      model: value.model,
      voice: value.voice,
      language: value.language,
      text: value.text,
      file: value.file,
      status: value.retrySafe === true ? "failed" : "unknown",
      attempts: value.attempts,
      ...attemptHistoryFields(value),
      ...(value.retrySafe === true ? { retrySafe: true } : {}),
      error: value.error,
    };
  }

  if (
    typeof value.latencyMs !== "number" ||
    !Number.isFinite(value.latencyMs) ||
    value.latencyMs < 0 ||
    !isPositiveSafeInteger(value.chunks) ||
    !isPositiveSafeInteger(value.audioBytes) ||
    value.audioBytes < 2 ||
    value.audioBytes % 2 !== 0 ||
    typeof value.audioDurationMs !== "number" ||
    !Number.isFinite(value.audioDurationMs) ||
    value.audioDurationMs < 0 ||
    !hasValidPcm16Wav(resolve(outputDir, value.file), value.audioBytes)
  ) {
    if (value.status === "pending" || value.status === "passed") {
      return {
        index: value.index,
        model: value.model,
        voice: value.voice,
        language: value.language,
        text: value.text,
        file: value.file,
        status: "unknown",
        attempts: value.attempts,
        ...attemptHistoryFields(value),
        error: "completed synthesis has a missing or invalid WAV artifact; inspect before retrying",
      };
    }
    return undefined;
  }
  return {
    index: value.index,
    model: value.model,
    voice: value.voice,
    language: value.language,
    text: value.text,
    file: value.file,
    status: "passed",
    attempts: value.attempts,
    ...attemptHistoryFields(value),
    latencyMs: value.latencyMs,
    chunks: value.chunks,
    audioBytes: value.audioBytes,
    audioDurationMs: value.audioDurationMs,
  };
}

function normalizeHttpRecord(
  value: unknown,
  outputDir: string,
  manifestWritesAudio: boolean,
): SarvamTtsMatrixRecord | undefined {
  if (
    !isRecord(value) ||
    (value.status !== "in_flight" &&
      value.status !== "unknown" &&
      value.status !== "passed" &&
      value.status !== "pending" &&
      value.status !== "failed") ||
    !isSafeArtifactFile(value.file) ||
    !hasLiveIdentity(value) ||
    (value.transport !== "rest" && value.transport !== "http-stream")
  ) {
    return undefined;
  }
  if (
    !isPositiveSafeInteger(value.index) ||
    !isPositiveSafeInteger(value.attempts) ||
    value.file !==
      createSarvamTtsMatrixArtifactFile(
        value.model,
        value.voice,
        value.language,
        value.text,
        value.transport,
      )
  ) {
    return undefined;
  }

  if (value.status === "in_flight") {
    if (!isPositiveSafeInteger(value.attempts)) return undefined;
    return {
      index: value.index,
      model: value.model,
      transport: value.transport,
      voice: value.voice,
      language: value.language,
      text: value.text,
      file: value.file,
      status: "unknown",
      attempts: value.attempts,
      ...attemptHistoryFields(value),
      hasAudioArtifact: false,
      error: "matrix stopped during an API attempt; inspect the outcome before retrying",
    };
  }
  if (value.status === "unknown") {
    if (!isPositiveSafeInteger(value.attempts) || typeof value.error !== "string") return undefined;
    return {
      index: value.index,
      model: value.model,
      transport: value.transport,
      voice: value.voice,
      language: value.language,
      text: value.text,
      file: value.file,
      status: "unknown",
      attempts: value.attempts,
      ...attemptHistoryFields(value),
      hasAudioArtifact: false,
      error: value.error,
    };
  }

  if (value.status === "failed") {
    if (typeof value.error !== "string" || !isPositiveSafeInteger(value.attempts)) return undefined;
    return {
      index: value.index,
      model: value.model,
      transport: value.transport,
      voice: value.voice,
      language: value.language,
      text: value.text,
      file: value.file,
      status: value.retrySafe === true ? "failed" : "unknown",
      attempts: value.attempts,
      ...attemptHistoryFields(value),
      hasAudioArtifact: false,
      ...(value.retrySafe === true ? { retrySafe: true } : {}),
      error: value.error,
      ...(typeof value.errorCode === "string" ? { errorCode: value.errorCode } : {}),
    };
  }

  const hasAudioArtifact =
    typeof value.hasAudioArtifact === "boolean" ? value.hasAudioArtifact : manifestWritesAudio;
  if (
    typeof value.latencyMs !== "number" ||
    !Number.isFinite(value.latencyMs) ||
    value.latencyMs < 0 ||
    !isPositiveSafeInteger(value.chunks) ||
    !isPositiveSafeInteger(value.audioBytes) ||
    value.audioBytes < 2 ||
    value.audioBytes % 2 !== 0 ||
    typeof value.audioDurationMs !== "number" ||
    !Number.isFinite(value.audioDurationMs) ||
    value.audioDurationMs < 0 ||
    (hasAudioArtifact && !hasValidPcm16Wav(resolve(outputDir, value.file), value.audioBytes))
  ) {
    if (value.status === "pending" || value.status === "passed") {
      return {
        index: value.index,
        model: value.model,
        transport: value.transport,
        voice: value.voice,
        language: value.language,
        text: value.text,
        file: value.file,
        status: "unknown",
        attempts: value.attempts,
        ...attemptHistoryFields(value),
        hasAudioArtifact: false,
        error: "completed synthesis has a missing or invalid WAV artifact; inspect before retrying",
      };
    }
    return undefined;
  }
  return {
    index: value.index,
    model: value.model,
    transport: value.transport,
    voice: value.voice,
    language: value.language,
    text: value.text,
    file: value.file,
    status: "passed",
    attempts: value.attempts,
    ...attemptHistoryFields(value),
    hasAudioArtifact,
    latencyMs: value.latencyMs,
    chunks: value.chunks,
    audioBytes: value.audioBytes,
    audioDurationMs: value.audioDurationMs,
  };
}

type LiveIdentityFields = {
  readonly model?: unknown;
  readonly voice?: unknown;
  readonly language?: unknown;
  readonly text?: unknown;
};

type ValidatedLiveIdentity = {
  readonly model: string;
  readonly voice: string;
  readonly language: string;
  readonly text: string;
};

function liveIdentityKey(value: LiveIdentityFields): string | undefined {
  if (!hasLiveIdentity(value)) return undefined;
  return JSON.stringify([value.model, value.voice, value.language, value.text]);
}

function hasLiveIdentity<T extends LiveIdentityFields>(
  value: T,
): value is T & ValidatedLiveIdentity {
  return (
    typeof value.model === "string" &&
    typeof value.voice === "string" &&
    typeof value.language === "string" &&
    typeof value.text === "string"
  );
}

function httpIdentityKey(value: {
  readonly model?: unknown;
  readonly transport?: unknown;
  readonly voice?: unknown;
  readonly language?: unknown;
  readonly text?: unknown;
}): string | undefined {
  const liveKey = liveIdentityKey(value);
  if (liveKey === undefined || (value.transport !== "rest" && value.transport !== "http-stream")) {
    return undefined;
  }
  return JSON.stringify([value.model, value.transport, value.voice, value.language, value.text]);
}

function isSafeArtifactFile(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    value.endsWith(".wav") &&
    basename(value) === value &&
    !value.includes("\\") &&
    !value.includes("\0")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
