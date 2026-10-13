import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { pcm16ToWav } from "../../../scripts/sarvam-tts-http-live-common.js";
import { createSarvamTtsMatrixArtifactFile } from "../../../scripts/sarvam-tts-matrix-jobs.js";
import {
  carrySarvamTtsMatrixAttemptHistory,
  mergeSarvamTtsMatrixRecordHistory,
  readPriorLiveRecords,
  selectSarvamTtsMatrixRecords,
  type SarvamTtsLiveMatrixJobIdentity,
  type SarvamTtsLiveMatrixRecord,
} from "../../../scripts/sarvam-tts-matrix-resume.js";

const job: SarvamTtsLiveMatrixJobIdentity = {
  index: 0,
  model: "bulbul:v4-flash",
  voice: "simran_en_customer",
  language: "en-IN",
  text: "A short matrix resume fixture.",
  file: createSarvamTtsMatrixArtifactFile(
    "bulbul:v4-flash",
    "simran_en_customer",
    "en-IN",
    "A short matrix resume fixture.",
  ),
};

const record: SarvamTtsLiveMatrixRecord = {
  ...job,
  index: 1,
  status: "passed",
  attempts: 1,
  latencyMs: 240,
  chunks: 2,
  audioBytes: 640,
  audioDurationMs: 20,
};

describe("Sarvam WebSocket matrix resume", () => {
  it("retains retry-safe failed attempt counts when a later run succeeds", () => {
    const outputDir = mkdtempSync(join(tmpdir(), "sarvam-live-matrix-resume-"));
    const failed: SarvamTtsLiveMatrixRecord = {
      ...job,
      index: 1,
      status: "failed",
      attempts: 3,
      lastRunAttempts: 3,
      retrySafe: true,
      error: "all failures were explicit pre-synthesis rejections",
    };
    try {
      writeFileSync(
        join(outputDir, "manifest.json"),
        JSON.stringify({ provider: "sarvam-tts", records: [failed] }),
      );

      const state = readPriorLiveRecords(outputDir, [job]);
      const previous = state.unresolvedByFile.get(job.file);
      expect(previous).toMatchObject({ status: "failed", attempts: 3, retrySafe: true });
      const [selected] = selectSarvamTtsMatrixRecords([job], state);
      expect(selected).toMatchObject({ status: "failed", attempts: 3 });
      expect(
        carrySarvamTtsMatrixAttemptHistory(previous!, { ...record, attempts: 1 }),
      ).toMatchObject({
        status: "passed",
        attempts: 4,
        lastRunAttempts: 1,
      });
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("reuses a successful result with a matching provider manifest and WAV", () => {
    const outputDir = mkdtempSync(join(tmpdir(), "sarvam-live-matrix-resume-"));
    try {
      writeFileSync(
        join(outputDir, "manifest.json"),
        JSON.stringify({ provider: "sarvam-tts", records: [record] }),
      );
      writeFileSync(join(outputDir, job.file), pcm16ToWav(new Uint8Array(640)));

      expect(readPriorLiveRecords(outputDir, [job]).reusableByFile).toEqual(
        new Map([[job.file, record]]),
      );
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("fails closed for a manifest owned by another provider", () => {
    const outputDir = mkdtempSync(join(tmpdir(), "sarvam-live-matrix-resume-"));
    try {
      writeFileSync(
        join(outputDir, "manifest.json"),
        JSON.stringify({ provider: "other-tts", records: [record] }),
      );

      expect(() => readPriorLiveRecords(outputDir, [job])).toThrow(/invalid Sarvam TTS manifest/u);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("fails closed when the records field has an invalid schema", () => {
    const outputDir = mkdtempSync(join(tmpdir(), "sarvam-live-matrix-resume-"));
    try {
      writeFileSync(
        join(outputDir, "manifest.json"),
        JSON.stringify({ provider: "sarvam-tts", records: null }),
      );

      expect(() => readPriorLiveRecords(outputDir, [job])).toThrow(/invalid Sarvam TTS manifest/u);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("fails closed for a pre-hash V3 WebSocket manifest instead of replaying its jobs", () => {
    const outputDir = mkdtempSync(join(tmpdir(), "sarvam-live-matrix-resume-"));
    const legacyJob: SarvamTtsLiveMatrixJobIdentity = {
      index: 0,
      model: "bulbul:v3",
      voice: "shubh",
      language: "en-IN",
      text: "A short matrix resume fixture.",
      file: "001-shubh-en-IN.wav",
    };
    const legacyRecord = {
      index: 1,
      voice: "shubh",
      language: "en-IN",
      text: legacyJob.text,
      file: legacyJob.file,
      status: "passed",
      attempts: 1,
      latencyMs: 240,
      chunks: 2,
      audioBytes: 640,
      audioDurationMs: 20,
    };
    try {
      writeFileSync(
        join(outputDir, "manifest.json"),
        JSON.stringify({ provider: "sarvam-tts", model: "bulbul:v3", records: [legacyRecord] }),
      );

      expect(() => readPriorLiveRecords(outputDir, [legacyJob])).toThrow(
        /legacy Sarvam TTS matrix manifest/u,
      );
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("recovers a pending completion and matches it after case ordering changes", () => {
    const outputDir = mkdtempSync(join(tmpdir(), "sarvam-live-matrix-resume-"));
    const movedJob = {
      ...job,
      index: 8,
    };
    try {
      writeFileSync(
        join(outputDir, "manifest.json"),
        JSON.stringify({ provider: "sarvam-tts", records: [{ ...record, status: "pending" }] }),
      );
      writeFileSync(join(outputDir, record.file), pcm16ToWav(new Uint8Array(640)));

      expect(readPriorLiveRecords(outputDir, [movedJob]).reusableByFile).toEqual(
        new Map([[movedJob.file, { ...record, index: 9 }]]),
      );
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("does not reuse a pending completion when its WAV is missing", () => {
    const outputDir = mkdtempSync(join(tmpdir(), "sarvam-live-matrix-resume-"));
    try {
      writeFileSync(
        join(outputDir, "manifest.json"),
        JSON.stringify({ provider: "sarvam-tts", records: [{ ...record, status: "pending" }] }),
      );

      const state = readPriorLiveRecords(outputDir, [job]);
      expect(state.reusableByFile).toEqual(new Map());
      expect(state.unresolvedByFile.get(job.file)).toMatchObject({ status: "unknown" });
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it.each(["missing", "corrupt"] as const)(
    "holds a passed synthesis with a %s WAV for explicit retry review",
    (artifactState) => {
      const outputDir = mkdtempSync(join(tmpdir(), "sarvam-live-matrix-resume-"));
      try {
        writeFileSync(
          join(outputDir, "manifest.json"),
          JSON.stringify({ provider: "sarvam-tts", records: [record] }),
        );
        if (artifactState === "corrupt")
          writeFileSync(join(outputDir, record.file), Buffer.from([1, 2]));

        const state = readPriorLiveRecords(outputDir, [job]);
        expect(state.reusableByFile).toEqual(new Map());
        expect(state.unresolvedByFile.get(job.file)).toMatchObject({ status: "unknown" });
        expect(selectSarvamTtsMatrixRecords([job], state)[0]?.status).toBe("unknown");
      } finally {
        rmSync(outputDir, { recursive: true, force: true });
      }
    },
  );

  it("holds an interrupted in-flight synthesis for operator review instead of resending", () => {
    const outputDir = mkdtempSync(join(tmpdir(), "sarvam-live-matrix-resume-"));
    const inFlight = { ...job, index: 1, status: "in_flight", attempts: 1 };
    try {
      writeFileSync(
        join(outputDir, "manifest.json"),
        JSON.stringify({ provider: "sarvam-tts", records: [inFlight] }),
      );

      const state = readPriorLiveRecords(outputDir, [job]);
      expect(state.reusableByFile).toEqual(new Map());
      expect(state.unresolvedByFile.get(job.file)).toMatchObject({
        status: "unknown",
        attempts: 1,
      });
      expect(selectSarvamTtsMatrixRecords([job], state)[0]?.status).toBe("unknown");
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["filename", { file: "damaged-attempt.wav" }],
    ["attempt count", { attempts: 0 }],
  ] as const)("fails closed when an in-flight live record has an invalid %s", (_, changes) => {
    const outputDir = mkdtempSync(join(tmpdir(), "sarvam-live-matrix-resume-"));
    const inFlight = { ...job, index: 1, status: "in_flight", attempts: 1, ...changes };
    try {
      writeFileSync(
        join(outputDir, "manifest.json"),
        JSON.stringify({ provider: "sarvam-tts", records: [inFlight] }),
      );

      expect(() => readPriorLiveRecords(outputDir, [job])).toThrow(/invalid Sarvam TTS manifest/u);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("does not reuse a pending WAV after the synthesis text changes", () => {
    const outputDir = mkdtempSync(join(tmpdir(), "sarvam-live-matrix-resume-"));
    const currentJob = {
      ...job,
      text: "Updated synthesis text.",
      file: createSarvamTtsMatrixArtifactFile(
        job.model,
        job.voice,
        job.language,
        "Updated synthesis text.",
      ),
    };
    try {
      writeFileSync(
        join(outputDir, "manifest.json"),
        JSON.stringify({ provider: "sarvam-tts", records: [{ ...record, status: "pending" }] }),
      );
      writeFileSync(join(outputDir, job.file), pcm16ToWav(new Uint8Array(640)));

      expect(readPriorLiveRecords(outputDir, [currentJob]).reusableByFile).toEqual(new Map());
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("preserves validated jobs outside a narrowed selection for a later full resume", () => {
    const outputDir = mkdtempSync(join(tmpdir(), "sarvam-live-matrix-resume-"));
    const secondJob: SarvamTtsLiveMatrixJobIdentity = {
      ...job,
      index: 1,
      voice: "aparna_hi_customer",
      file: createSarvamTtsMatrixArtifactFile(
        job.model,
        "aparna_hi_customer",
        job.language,
        job.text,
      ),
    };
    const secondRecord: SarvamTtsLiveMatrixRecord = {
      ...secondJob,
      index: 2,
      status: "passed",
      attempts: 1,
      latencyMs: 260,
      chunks: 2,
      audioBytes: 640,
      audioDurationMs: 20,
    };
    try {
      writeFileSync(
        join(outputDir, "manifest.json"),
        JSON.stringify({ provider: "sarvam-tts", records: [record, secondRecord] }),
      );
      writeFileSync(join(outputDir, job.file), pcm16ToWav(new Uint8Array(640)));
      writeFileSync(join(outputDir, secondJob.file), pcm16ToWav(new Uint8Array(640)));

      const narrowed = readPriorLiveRecords(outputDir, [job]);
      expect(narrowed.reusableByFile).toEqual(new Map([[job.file, record]]));
      expect(narrowed.history).toContainEqual(secondRecord);
      writeFileSync(
        join(outputDir, "manifest.json"),
        JSON.stringify({
          provider: "sarvam-tts",
          records: [record],
          history: mergeSarvamTtsMatrixRecordHistory(narrowed.history, [record]),
        }),
      );

      expect(readPriorLiveRecords(outputDir, [job, secondJob]).reusableByFile).toEqual(
        new Map([
          [job.file, record],
          [secondJob.file, secondRecord],
        ]),
      );
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("keeps unknown attempts and cumulative counts through explicit retry and resume", () => {
    const outputDir = mkdtempSync(join(tmpdir(), "sarvam-live-matrix-resume-"));
    const unknown: SarvamTtsLiveMatrixRecord = {
      ...job,
      index: 1,
      status: "unknown",
      attempts: 2,
      error: "connection closed after synthesis started",
    };
    const retried = carrySarvamTtsMatrixAttemptHistory(unknown, {
      ...record,
      attempts: 1,
    });
    try {
      writeFileSync(
        join(outputDir, "manifest.json"),
        JSON.stringify({
          provider: "sarvam-tts",
          records: [retried],
          history: mergeSarvamTtsMatrixRecordHistory([unknown], [retried]),
        }),
      );
      writeFileSync(join(outputDir, retried.file), pcm16ToWav(new Uint8Array(640)));

      expect(readPriorLiveRecords(outputDir, [job]).reusableByFile.get(job.file)).toMatchObject({
        status: "passed",
        attempts: 3,
        lastRunAttempts: 1,
        priorUnknownAttempts: 2,
        priorUnknownError: unknown.error,
      });
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });
});
