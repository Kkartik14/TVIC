import { describe, expect, it } from "vitest";

import type { SpeechToTextProvider, SttStream, TranscriptEvent } from "@tvic/core";
import { AsyncQueue } from "@tvic/media";
import type { ResolvedSttReconnectOptions } from "../src/resilient-stt-policy.js";
import { ResilientSttAgentContextCoordinator } from "../src/resilient-stt-context-coordinator.js";
import type { SttJournalEntry } from "../src/resilient-stt-journal.js";

function coordinatorFixture(updateAgentContext: SttStream["updateAgentContext"]) {
  const journal: SttJournalEntry[] = [];
  const stream = {
    events: new AsyncQueue<TranscriptEvent>(),
    timestampOrigin: "generation",
    updateAgentContext,
    async sendAudio() {},
    async commit() {},
    async close() {},
  } as SttStream;
  const provider = { name: "context-coordinator-test-stt" } as SpeechToTextProvider;
  const coordinator = new ResilientSttAgentContextCoordinator({
    provider,
    options: { contextUpdateTimeoutMs: 1_000 } as Pick<
      ResolvedSttReconnectOptions,
      "contextUpdateTimeoutMs"
    >,
    journal,
    lifecycleSignal: new AbortController().signal,
    isAcceptingUpdates: () => true,
    getActiveStream: () => stream,
    getCursor: () => 0,
    getGeneration: () => 1,
    isClosing: () => false,
    isClosedOrTerminal: () => false,
    isRecovering: () => false,
    isCurrentOrOpeningGeneration: (generation, candidate) =>
      generation === 1 && candidate === stream,
    compactJournal: () => undefined,
    hasCommandCapacity: () =>
      journal.filter((entry) => entry.kind !== "agent_context" || !entry.settled).length < 512,
    signalWork: () => undefined,
    notifyProgress: () => undefined,
    failTerminal: (error) => {
      throw error;
    },
    handleGenerationFailure: (_generation, _candidate, error) => {
      throw error;
    },
  });
  return { coordinator, journal, stream };
}

describe("ResilientSttAgentContextCoordinator", () => {
  it("serializes provider writes and settles updates in version order", async () => {
    const writes: string[] = [];
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const { coordinator, journal, stream } = coordinatorFixture(async (context) => {
      writes.push(context);
      await (context === "first" ? firstGate : secondGate);
    });

    const firstUpdate = coordinator.update("first");
    const firstEntry = journal[0];
    if (!firstEntry || firstEntry.kind !== "agent_context") {
      throw new Error("first context entry was not appended");
    }
    const firstWrite = coordinator.dispatch(firstEntry, stream, 1);
    const secondUpdate = coordinator.update("second");
    const secondEntry = journal[1];
    if (!secondEntry || secondEntry.kind !== "agent_context") {
      throw new Error("second context entry was not appended");
    }
    const secondWrite = coordinator.dispatch(secondEntry, stream, 1);

    await Promise.resolve();
    await Promise.resolve();
    expect(writes).toEqual(["first"]);
    releaseFirst();
    await firstWrite;
    await Promise.resolve();
    await Promise.resolve();
    expect(writes).toEqual(["first", "second"]);
    releaseSecond();
    await secondWrite;
    await expect(firstUpdate).resolves.toBeUndefined();
    await expect(secondUpdate).resolves.toBeUndefined();
  });

  it("drops a canceled version from replay and sends the latest live context", async () => {
    const writes: string[] = [];
    const { coordinator, journal, stream } = coordinatorFixture(async (context) => {
      writes.push(context);
    });
    const abort = new AbortController();
    const cancelledUpdate = coordinator.update("cancelled", abort.signal);
    abort.abort();
    await expect(cancelledUpdate).rejects.toMatchObject({ code: "stt.context_update_failed" });

    const latestUpdate = coordinator.update("latest");
    await coordinator.replayLatest(stream, 1);
    await expect(latestUpdate).resolves.toBeUndefined();

    expect(journal.map((entry) => entry.kind === "agent_context" && entry.context)).toEqual([
      "cancelled",
      "latest",
    ]);
    expect(writes).toEqual(["latest"]);
  });
});
