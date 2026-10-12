import { describe, expect, it } from "vitest";

import type { SessionId } from "@tvic/core";
import type { PipelineVoiceLoopResult, VoiceEvent } from "@tvic/runtime";

import { ManagedVoiceAgentRun, type ManagedRunController } from "../src/managed-agent-run.js";

describe("managed voice agent run iterator", () => {
  it("waits for run cleanup before propagating an event iterator failure", async () => {
    const iteratorError = new Error("event queue overflow");
    let resolveCompletion!: (value: PipelineVoiceLoopResult) => void;
    const completion = new Promise<PipelineVoiceLoopResult>((resolve) => {
      resolveCompletion = resolve;
    });
    let cancelled = false;
    const rawIterator: AsyncIterator<VoiceEvent> = {
      async next() {
        throw iteratorError;
      },
    };
    const controller: ManagedRunController = {
      claim: () => ({ completion, iterator: rawIterator }),
      cancel: () => {
        cancelled = true;
      },
    };
    const run = new ManagedVoiceAgentRun("session_iterator_error" as SessionId, controller);
    const next = run[Symbol.asyncIterator]().next();
    let settled = false;
    void next
      .finally(() => {
        settled = true;
      })
      .catch(() => undefined);

    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(cancelled).toBe(false);

    resolveCompletion({} as PipelineVoiceLoopResult);
    await expect(next).rejects.toBe(iteratorError);
    expect(cancelled).toBe(false);
  });
});
