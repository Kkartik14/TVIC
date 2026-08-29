import type { InputAudioChunk } from "@tvic/core";

export type SttJournalEntry =
  | {
      readonly kind: "audio";
      readonly chunk: InputAudioChunk;
      readonly bytes: number;
      readonly offsetMs: number;
      readonly admittedAtMs: number;
      dispatchedAtMs?: number;
    }
  | {
      readonly kind: "commit";
      readonly admittedAtMs: number;
      settled: boolean;
      readonly resolve: () => void;
      readonly reject: (error: unknown) => void;
    };

export function journalBytes(journal: readonly SttJournalEntry[]): number {
  return journal.reduce((total, entry) => total + (entry.kind === "audio" ? entry.bytes : 0), 0);
}

export function findReplayStart(
  journal: readonly SttJournalEntry[],
  cursor: number,
  nowMs: number,
  uncertainWindowMs: number,
): number {
  const cutoff = nowMs - uncertainWindowMs;
  let start = cursor;
  while (start > 0) {
    const previous = journal[start - 1];
    if (!previous) {
      break;
    }
    if (previous.kind === "commit") {
      start -= 1;
      continue;
    }
    if ((previous.dispatchedAtMs ?? previous.admittedAtMs) >= cutoff) {
      start -= 1;
      continue;
    }
    break;
  }
  return start;
}

export interface JournalCompactionResult {
  readonly cursor: number;
  readonly replayStart: number;
  readonly replayBoundary: number;
}

export function compactJournal(
  journal: SttJournalEntry[],
  cursor: number,
  replayStart: number,
  replayBoundary: number,
  nowMs: number,
  uncertainWindowMs: number,
): JournalCompactionResult {
  const cutoff = nowMs - uncertainWindowMs;
  const lastSettledCommit = journal.reduce(
    (last, entry, index) => (entry.kind === "commit" && entry.settled ? index : last),
    -1,
  );
  const retainAudio = journal.map(
    (entry, index) =>
      entry.kind === "audio" &&
      (index >= cursor || (entry.dispatchedAtMs ?? entry.admittedAtMs) >= cutoff),
  );
  const retainedAudioAfter: boolean[] = [];
  let audioAfter = false;
  for (let index = journal.length - 1; index >= 0; index -= 1) {
    retainedAudioAfter[index] = audioAfter;
    audioAfter ||= retainAudio[index] ?? false;
  }

  const keptIndices = journal.flatMap((entry, index) => {
    if (index >= cursor || retainAudio[index]) {
      return [index];
    }
    if (
      entry.kind === "commit" &&
      (index === lastSettledCommit || retainedAudioAfter[index] === true)
    ) {
      return [index];
    }
    return [];
  });
  if (keptIndices.length === journal.length) {
    return { cursor, replayStart, replayBoundary };
  }

  const nextJournal = keptIndices.map((index) => journal[index]!);
  const mapIndex = (oldIndex: number): number => {
    let mapped = 0;
    while (mapped < keptIndices.length && keptIndices[mapped]! < oldIndex) {
      mapped += 1;
    }
    return mapped;
  };
  journal.splice(0, journal.length, ...nextJournal);
  return {
    cursor: mapIndex(cursor),
    replayStart: mapIndex(replayStart),
    replayBoundary: mapIndex(replayBoundary),
  };
}
