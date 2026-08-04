import { describe, expect, it } from "vitest";

import type { TurnStatus } from "@tvic/core";

import {
  PipelineVoiceLoop,
  createRuntime,
  defineAgent,
  type AssistantTextRecord,
} from "../src/index.js";
import {
  buildAgent,
  llmEvent,
  makeCallHandle,
  makeLlm,
  makeStt,
  streamEnded,
  streamStarted,
  until,
} from "./harness.js";

describe("assistant text observation", () => {
  it.each([
    { delivery: "delivered" as const, llmFails: false, status: "completed" as const },
    { delivery: "dropped" as const, llmFails: false, status: "cancelled" as const },
    { delivery: "delivered" as const, llmFails: true, status: "failed" as const },
  ])("reports a $status terminal turn exactly once", async ({ delivery, llmFails, status }) => {
    const records: AssistantTextRecord[] = [];
    const actual = await runScenario({
      delivery,
      llmFails,
      report: (record) => records.push(record),
    });
    expect(actual).toBe(status);
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual(
      expect.objectContaining({
        status,
        text: llmFails ? "" : "Visible answer.",
        ...(llmFails ? {} : { delivered: delivery === "delivered" }),
      }),
    );
  });

  it("swallows observer failures and omission leaves execution unchanged", async () => {
    await expect(
      runScenario({
        delivery: "delivered",
        llmFails: false,
        report() {
          throw new Error("observer failed");
        },
      }),
    ).resolves.toBe("completed");
    await expect(runScenario({ delivery: "delivered", llmFails: false })).resolves.toBe(
      "completed",
    );
  });
});

async function runScenario(options: {
  readonly delivery: "delivered" | "dropped";
  readonly llmFails: boolean;
  readonly report?: (record: AssistantTextRecord) => void;
}): Promise<TurnStatus> {
  const runtime = createRuntime();
  await runtime.start();
  const base = buildAgent();
  const { tts: _tts, ...providers } = base.providers;
  const stt = makeStt();
  const llm = makeLlm((request) =>
    options.llmFails
      ? [
          llmEvent(request, 1, {
            type: "llm.failed",
            error: {
              code: "llm.test_failure",
              message: "failed",
              category: "provider",
              retriable: false,
            },
          }),
        ]
      : [llmEvent(request, 1, { type: "llm.completed", text: "Visible answer.", toolCalls: [] })],
  );
  const agent = defineAgent({
    ...base,
    providers: { ...providers, stt: stt.provider, llm },
  });
  const session = await runtime.startSession(agent, { channel: "simulated" });
  const call = makeCallHandle({ textDelivery: options.delivery });
  const running = new PipelineVoiceLoop({
    runtime,
    session,
    agent,
    callHandle: call.handle,
    llmModel: "gpt-test",
    ...(options.report ? { onAssistantText: options.report } : {}),
  }).run();
  call.push(streamStarted(session.id));
  stt.pushFinal(session.id, "question");
  await until(async () => {
    const status = (await runtime.inspectSession(session.id)).turns[0]?.status;
    return status === "completed" || status === "cancelled" || status === "failed";
  }, "assistant text terminal turn");
  call.push(streamEnded(session.id));
  await running;
  return (await runtime.inspectSession(session.id)).turns[0]?.status ?? "failed";
}
