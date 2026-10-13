import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { pcm16ToWav } from "../../../scripts/sarvam-tts-http-live-common.js";
import {
  assertSarvamTtsMatrixNoUnknownRetry,
  carrySarvamTtsMatrixAttemptHistory,
  mergeSarvamTtsMatrixRecordHistory,
  readPriorRecords,
  selectSarvamTtsMatrixRecords,
  type SarvamTtsMatrixJobIdentity,
  type SarvamTtsMatrixRecord,
} from "../../../scripts/sarvam-tts-matrix-resume.js";
import { createSarvamTtsMatrixArtifactFile } from "../../../scripts/sarvam-tts-matrix-jobs.js";

const job: SarvamTtsMatrixJobIdentity = {
  index: 0,
  model: "bulbul:v4-flash",
  transport: "rest",
  voice: "simran_en_customer",
  language: "en-IN",
  text: "A short matrix resume fixture.",
  file: createSarvamTtsMatrixArtifactFile(
    "bulbul:v4-flash",
    "simran_en_customer",
    "en-IN",
    "A short matrix resume fixture.",
    "rest",
  ),
};

const record: SarvamTtsMatrixRecord = {
  ...job,
  index: 1,
  status: "passed",
  attempts: 1,
  latencyMs: 240,
  chunks: 2,
  audioBytes: 640,
  audioDurationMs: 20,
};

describe("Sarvam HTTP matrix resume", () => {
  it("rejects the deprecated ambiguous-outcome replay override", () => {
    expect(() => assertSarvamTtsMatrixNoUnknownRetry(true)).toThrow(
      /Ambiguous Sarvam TTS outcomes are never replayed automatically/u,
    );
    expect(() => assertSarvamTtsMatrixNoUnknownRetry(false)).not.toThrow();
  });

  it("retains retry-safe failed attempt counts when a later run succeeds", () => {
    const outputDir = mkdtempSync(join(tmpdir(), "sarvam-matrix-resume-"));
    const failed: SarvamTtsMatrixRecord = {
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
        JSON.stringify({ provider: "sarvam-tts", writeAudio: false, records: [failed] }),
      );

      const state = readPriorRecords(outputDir, [job], false);
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

  it("reuses a successful metadata-only result without requiring an audio file", () => {
    const outputDir = mkdtempSync(join(tmpdir(), "sarvam-matrix-resume-"));
    try {
      writeFileSync(
        join(outputDir, "manifest.json"),
        JSON.stringify({ provider: "sarvam-tts", writeAudio: false, records: [record] }),
      );

      expect(readPriorRecords(outputDir, [job], false).reusableByFile).toEqual(
        new Map([[job.file, { ...record, hasAudioArtifact: false }]]),
      );
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("reuses an audio result only when its WAV artifact is valid", () => {
    const outputDir = mkdtempSync(join(tmpdir(), "sarvam-matrix-resume-"));
    try {
      writeFileSync(
        join(outputDir, "manifest.json"),
        JSON.stringify({ provider: "sarvam-tts", writeAudio: true, records: [record] }),
      );
      writeFileSync(join(outputDir, job.file), pcm16ToWav(new Uint8Array(640)));

      expect(readPriorRecords(outputDir, [job], true).reusableByFile).toEqual(
        new Map([[job.file, { ...record, hasAudioArtifact: true }]]),
      );
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("does not reuse an audio artifact from a metadata-only manifest", () => {
    const outputDir = mkdtempSync(join(tmpdir(), "sarvam-matrix-resume-"));
    try {
      writeFileSync(
        join(outputDir, "manifest.json"),
        JSON.stringify({ provider: "sarvam-tts", writeAudio: false, records: [record] }),
      );
      writeFileSync(join(outputDir, job.file), pcm16ToWav(new Uint8Array(640)));

      expect(readPriorRecords(outputDir, [job], true).reusableByFile).toEqual(new Map());
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("fails closed for a manifest owned by another provider", () => {
    const outputDir = mkdtempSync(join(tmpdir(), "sarvam-matrix-resume-"));
    try {
      writeFileSync(
        join(outputDir, "manifest.json"),
        JSON.stringify({ provider: "other-tts", records: [record] }),
      );

      expect(() => readPriorRecords(outputDir, [job], false)).toThrow(
        /invalid Sarvam TTS manifest/u,
      );
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("fails closed for a valid JSON manifest with an invalid schema", () => {
    const outputDir = mkdtempSync(join(tmpdir(), "sarvam-matrix-resume-"));
    try {
      writeFileSync(
        join(outputDir, "manifest.json"),
        JSON.stringify({ provider: "sarvam-tts", records: null }),
      );

      expect(() => readPriorRecords(outputDir, [job], false)).toThrow(
        /invalid Sarvam TTS manifest/u,
      );
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("fails closed for a pre-hash V3 HTTP manifest instead of replaying its jobs", () => {
    const outputDir = mkdtempSync(join(tmpdir(), "sarvam-matrix-resume-"));
    const legacyJob: SarvamTtsMatrixJobIdentity = {
      index: 0,
      model: "bulbul:v3",
      transport: "rest",
      voice: "shubh",
      language: "en-IN",
      text: "A short matrix resume fixture.",
      file: "0001-rest-shubh-en-IN.wav",
    };
    const legacyRecord = {
      index: 1,
      transport: "rest",
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

      expect(() => readPriorRecords(outputDir, [legacyJob], false)).toThrow(
        /legacy Sarvam TTS matrix manifest/u,
      );
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("fails closed on an artifact path outside the resume directory", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "sarvam-matrix-resume-"));
    const outputDir = join(rootDir, "output");
    mkdirSync(outputDir);
    const escapedRecord = { ...record, file: "../escape.wav" };
    try {
      writeFileSync(
        join(outputDir, "manifest.json"),
        JSON.stringify({ provider: "sarvam-tts", writeAudio: true, records: [escapedRecord] }),
      );
      writeFileSync(join(rootDir, "escape.wav"), pcm16ToWav(new Uint8Array(640)));

      expect(() => readPriorRecords(outputDir, [job], true)).toThrow(
        /invalid Sarvam TTS manifest record/u,
      );
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("reuses legacy audio manifests when their WAV artifact is valid", () => {
    const outputDir = mkdtempSync(join(tmpdir(), "sarvam-matrix-resume-"));
    try {
      writeFileSync(
        join(outputDir, "manifest.json"),
        JSON.stringify({ provider: "sarvam-tts", records: [record] }),
      );
      writeFileSync(join(outputDir, job.file), pcm16ToWav(new Uint8Array(640)));

      expect(readPriorRecords(outputDir, [job], true).reusableByFile).toEqual(
        new Map([[job.file, { ...record, hasAudioArtifact: true }]]),
      );
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("recovers a pending completion from a valid WAV after a crash before the pass checkpoint", () => {
    const outputDir = mkdtempSync(join(tmpdir(), "sarvam-matrix-resume-"));
    const pending = { ...record, status: "pending" as const };
    try {
      writeFileSync(
        join(outputDir, "manifest.json"),
        JSON.stringify({ provider: "sarvam-tts", writeAudio: true, records: [pending] }),
      );
      writeFileSync(join(outputDir, record.file), pcm16ToWav(new Uint8Array(640)));

      expect(readPriorRecords(outputDir, [job], true).reusableByFile).toEqual(
        new Map([[job.file, { ...record, status: "passed", hasAudioArtifact: true }]]),
      );
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("does not reuse a prior-text WAV for a pending result with changed text", () => {
    const outputDir = mkdtempSync(join(tmpdir(), "sarvam-matrix-resume-"));
    const priorText = "prior synthesis text";
    const currentText = "updated synthesis text";
    const priorFile = createSarvamTtsMatrixArtifactFile(
      job.model,
      job.voice,
      job.language,
      priorText,
      job.transport,
    );
    const currentJob = {
      ...job,
      text: currentText,
      file: createSarvamTtsMatrixArtifactFile(
        job.model,
        job.voice,
        job.language,
        currentText,
        job.transport,
      ),
    };
    const pending = { ...record, text: priorText, file: priorFile, status: "pending" as const };
    try {
      writeFileSync(
        join(outputDir, "manifest.json"),
        JSON.stringify({ provider: "sarvam-tts", writeAudio: true, records: [pending] }),
      );
      writeFileSync(join(outputDir, priorFile), pcm16ToWav(new Uint8Array(640)));

      expect(readPriorRecords(outputDir, [currentJob], true).reusableByFile).toEqual(new Map());
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("does not reuse a pending completion without its complete WAV artifact", () => {
    const outputDir = mkdtempSync(join(tmpdir(), "sarvam-matrix-resume-"));
    try {
      writeFileSync(
        join(outputDir, "manifest.json"),
        JSON.stringify({
          provider: "sarvam-tts",
          writeAudio: true,
          records: [{ ...record, status: "pending" }],
        }),
      );

      const state = readPriorRecords(outputDir, [job], true);
      expect(state.reusableByFile).toEqual(new Map());
      expect(state.unresolvedByFile.get(job.file)).toMatchObject({ status: "unknown" });
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it.each(["missing", "corrupt"] as const)(
    "holds a passed synthesis with a %s WAV for explicit retry review",
    (artifactState) => {
      const outputDir = mkdtempSync(join(tmpdir(), "sarvam-matrix-resume-"));
      try {
        writeFileSync(
          join(outputDir, "manifest.json"),
          JSON.stringify({ provider: "sarvam-tts", writeAudio: true, records: [record] }),
        );
        if (artifactState === "corrupt")
          writeFileSync(join(outputDir, record.file), Buffer.from([1, 2]));

        const state = readPriorRecords(outputDir, [job], true);
        expect(state.reusableByFile).toEqual(new Map());
        expect(state.unresolvedByFile.get(job.file)).toMatchObject({ status: "unknown" });
        expect(selectSarvamTtsMatrixRecords([job], state)[0]?.status).toBe("unknown");
      } finally {
        rmSync(outputDir, { recursive: true, force: true });
      }
    },
  );

  it("holds a metadata-only pass when a resumed run now requires a WAV artifact", () => {
    const outputDir = mkdtempSync(join(tmpdir(), "sarvam-matrix-resume-"));
    try {
      writeFileSync(
        join(outputDir, "manifest.json"),
        JSON.stringify({ provider: "sarvam-tts", writeAudio: false, records: [record] }),
      );

      const state = readPriorRecords(outputDir, [job], true);
      expect(state.reusableByFile).toEqual(new Map());
      expect(state.unresolvedByFile.get(job.file)).toMatchObject({ status: "unknown" });
      expect(selectSarvamTtsMatrixRecords([job], state)[0]?.status).toBe("unknown");
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("holds an interrupted in-flight synthesis for operator review instead of resending", () => {
    const outputDir = mkdtempSync(join(tmpdir(), "sarvam-matrix-resume-"));
    const inFlight = { ...job, index: 1, status: "in_flight", attempts: 1 };
    try {
      writeFileSync(
        join(outputDir, "manifest.json"),
        JSON.stringify({ provider: "sarvam-tts", writeAudio: true, records: [inFlight] }),
      );

      const state = readPriorRecords(outputDir, [job], true);
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
  ] as const)("fails closed when an in-flight HTTP record has an invalid %s", (_, changes) => {
    const outputDir = mkdtempSync(join(tmpdir(), "sarvam-matrix-resume-"));
    const inFlight = { ...job, index: 1, status: "in_flight", attempts: 1, ...changes };
    try {
      writeFileSync(
        join(outputDir, "manifest.json"),
        JSON.stringify({ provider: "sarvam-tts", writeAudio: true, records: [inFlight] }),
      );

      expect(() => readPriorRecords(outputDir, [job], true)).toThrow(
        /invalid Sarvam TTS manifest/u,
      );
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("matches completed cases by identity when selection ordering changes", () => {
    const outputDir = mkdtempSync(join(tmpdir(), "sarvam-matrix-resume-"));
    const movedJob = {
      ...job,
      index: 5,
    };
    try {
      writeFileSync(
        join(outputDir, "manifest.json"),
        JSON.stringify({ provider: "sarvam-tts", writeAudio: true, records: [record] }),
      );
      writeFileSync(join(outputDir, record.file), pcm16ToWav(new Uint8Array(640)));

      expect(readPriorRecords(outputDir, [movedJob], true).reusableByFile).toEqual(
        new Map([[movedJob.file, { ...record, index: 6, hasAudioArtifact: true }]]),
      );
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("preserves completed jobs outside a narrowed selection for a later full resume", () => {
    const outputDir = mkdtempSync(join(tmpdir(), "sarvam-matrix-resume-"));
    const secondJob: SarvamTtsMatrixJobIdentity = {
      ...job,
      index: 1,
      voice: "aparna_hi_customer",
      file: createSarvamTtsMatrixArtifactFile(
        job.model,
        "aparna_hi_customer",
        job.language,
        job.text,
        job.transport,
      ),
    };
    const secondRecord: SarvamTtsMatrixRecord = {
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
        JSON.stringify({
          provider: "sarvam-tts",
          writeAudio: false,
          records: [record, secondRecord],
        }),
      );

      const narrowed = readPriorRecords(outputDir, [job], false);
      expect(narrowed.reusableByFile).toEqual(
        new Map([[job.file, { ...record, hasAudioArtifact: false }]]),
      );
      expect(narrowed.history).toContainEqual({ ...secondRecord, hasAudioArtifact: false });
      writeFileSync(
        join(outputDir, "manifest.json"),
        JSON.stringify({
          provider: "sarvam-tts",
          writeAudio: false,
          records: [record],
          history: mergeSarvamTtsMatrixRecordHistory(narrowed.history, [record]),
        }),
      );

      expect(readPriorRecords(outputDir, [job, secondJob], false).reusableByFile).toEqual(
        new Map([
          [job.file, { ...record, hasAudioArtifact: false }],
          [secondJob.file, { ...secondRecord, hasAudioArtifact: false }],
        ]),
      );
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("keeps unknown attempts and cumulative counts through explicit retry and resume", () => {
    const outputDir = mkdtempSync(join(tmpdir(), "sarvam-matrix-resume-"));
    const unknown: SarvamTtsMatrixRecord = {
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
          writeAudio: false,
          records: [retried],
          history: mergeSarvamTtsMatrixRecordHistory([unknown], [retried]),
        }),
      );

      expect(readPriorRecords(outputDir, [job], false).reusableByFile.get(job.file)).toMatchObject({
        status: "passed",
        attempts: 3,
        lastRunAttempts: 1,
        priorUnknownAttempts: 2,
        priorUnknownError: unknown.error,
      });

      const retrySafeFailure: SarvamTtsMatrixRecord = {
        ...unknown,
        status: "failed",
        attempts: 1,
        retrySafe: true,
        error: "the explicit retry was rejected before synthesis",
      };
      const stillUnknown = carrySarvamTtsMatrixAttemptHistory(unknown, retrySafeFailure);
      expect(stillUnknown).toMatchObject({
        status: "unknown",
        attempts: 3,
        priorUnknownAttempts: 2,
      });
      expect(stillUnknown).not.toHaveProperty("retrySafe");
      writeFileSync(
        join(outputDir, "manifest.json"),
        JSON.stringify({
          provider: "sarvam-tts",
          writeAudio: false,
          records: [stillUnknown],
          history: [stillUnknown],
        }),
      );
      expect(
        readPriorRecords(outputDir, [job], false).unresolvedByFile.get(job.file),
      ).toMatchObject({ status: "unknown", attempts: 3, priorUnknownAttempts: 2 });
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });
});
