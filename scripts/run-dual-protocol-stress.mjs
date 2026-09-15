import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

import { AsyncQueue } from "../packages/media/src/async-queue.ts";
import { DualProtocolResultImpl } from "../packages/runtime/src/dual-protocol-result.ts";

const DEFAULT_ITERATIONS = 1_000;

export async function runDualProtocolStress(iterations = DEFAULT_ITERATIONS) {
  if (!Number.isSafeInteger(iterations) || iterations < 1) {
    throw new RangeError("iterations must be a positive safe integer");
  }

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const events = new AsyncQueue({ maxBuffered: 1_024 });
    const expectedEvents = [
      { kind: "turn_started", iteration },
      { kind: "transcript_delta", text: "hello" },
      { kind: "audio_output", sequence: 1 },
      { kind: "turn_completed" },
      { kind: "call_ended", reason: "completed" },
    ];
    const runPromise = (async () => {
      for (const event of expectedEvents) {
        assert.equal(events.push(event), true);
      }
      events.close();
      return { turnsHandled: 1, turnsFailed: 0 };
    })();
    const result = new DualProtocolResultImpl({
      runPromise,
      events,
      cancel: () => undefined,
      sessionId: `stress_${iteration}`,
      consumer: "public",
    });
    const received = [];
    const eventsPromise = (async () => {
      for await (const event of result) received.push(event);
      return received;
    })();

    const [drained, settled] = await Promise.all([eventsPromise, result]);
    assert.equal(settled.turnsHandled, 1);
    assert.equal(drained.length, expectedEvents.length);
    assert.deepEqual(drained, expectedEvents);
  }

  return { iterations };
}

const requested = Number(process.env.TVIC_DUAL_PROTOCOL_ITERATIONS ?? DEFAULT_ITERATIONS);
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runDualProtocolStress(
    Number.isSafeInteger(requested) && requested > 0 ? requested : DEFAULT_ITERATIONS,
  );
  process.stdout.write(`dual-protocol stress ok: ${requested} iterations\n`);
}
