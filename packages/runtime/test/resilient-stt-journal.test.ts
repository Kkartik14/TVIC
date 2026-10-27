import { describe, expect, it } from "vitest";

import { compactJournal, type SttJournalEntry } from "../src/resilient-stt-journal.js";

describe("resilient STT journal compaction", () => {
  it("drops settled context entries behind a blocked audio cursor", () => {
    const blockedAudio = {
      kind: "audio",
      bytes: 2,
      admittedAtMs: 0,
      offsetMs: 0,
    } as unknown as SttJournalEntry;
    const settledContexts = Array.from({ length: 20_001 }, (_value, index) => {
      const context = {
        context: `cancelled-${index}`,
        version: index + 1,
      };
      return {
        kind: "agent_context",
        context: context.context,
        version: context.version,
        settled: true,
        latestContext: context,
        admittedAtMs: index,
        waiter: {
          promise: Promise.resolve(),
          resolve: () => undefined,
          reject: () => undefined,
        },
      } satisfies SttJournalEntry;
    });
    const journal = [blockedAudio, ...settledContexts];

    const result = compactJournal(journal, 0, 0, journal.length, 30_000, 0);

    expect(journal).toEqual([blockedAudio]);
    expect(result).toEqual({ cursor: 0, replayStart: 0, replayBoundary: 1 });
  });
});
