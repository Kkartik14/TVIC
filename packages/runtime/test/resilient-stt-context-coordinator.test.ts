import { describe, expect, it } from "vitest";

import type { SpeechToTextProvider, SttStream, TranscriptEvent } from "@tvic/core";
import { AsyncQueue } from "@tvic/media";
import type { ResolvedSttReconnectOptions } from "../src/resilient-stt-policy.js";
import { ResilientSttAgentContextCoordinator } from "../src/resilient-stt-context-coordinator.js";
import type { SttJournalEntry } from "../src/resilient-stt-journal.js";

function coordinatorFixture(updateAgentContext: SttStream["updateAgentContext"]) {
  const journal: SttJournalEntry[] = [];
  let currentGeneration = 1;
  let closing = false;
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
    isClosing: () => closing,
    isClosedOrTerminal: () => false,
    isRecovering: () => false,
    isCurrentOrOpeningGeneration: (generation, candidate) =>
      generation === currentGeneration && candidate === stream,
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
    noteContextUpdateAccepted: () => undefined,
  });
  return {
    coordinator,
    journal,
    stream,
    setClosing(value: boolean) {
      closing = value;
    },
    setGeneration(value: number) {
      currentGeneration = value;
    },
  };
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

  it("suppresses replay-only context errors after graceful close starts", async () => {
    let writeCount = 0;
    let markReplayStarted!: () => void;
    const replayStarted = new Promise<void>((resolve) => {
      markReplayStarted = resolve;
    });
    let rejectReplay!: (error: Error) => void;
    const replayGate = new Promise<void>((_resolve, reject) => {
      rejectReplay = reject;
    });
    const { coordinator, journal, stream, setClosing, setGeneration } = coordinatorFixture(
      async () => {
        writeCount += 1;
        if (writeCount > 1) {
          markReplayStarted();
          await replayGate;
        }
      },
    );
    const initialUpdate = coordinator.update("accepted context");
    const initialEntry = journal[0];
    if (!initialEntry || initialEntry.kind !== "agent_context") {
      throw new Error("initial context entry was not appended");
    }
    await coordinator.dispatch(initialEntry, stream, 1);
    await expect(initialUpdate).resolves.toBeUndefined();

    const errors: unknown[] = [];
    coordinator.subscribeErrors((error) => errors.push(error));
    setGeneration(2);
    const replay = coordinator.replayLatest(stream, 2);
    await replayStarted;
    setClosing(true);
    rejectReplay(new Error("replay rejected while closing"));
    await replay;

    expect(writeCount).toBe(2);
    expect(errors).toEqual([]);
  });
});
