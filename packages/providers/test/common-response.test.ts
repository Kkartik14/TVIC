import { describe, expect, it } from "vitest";

import { readBoundedResponseText } from "../src/common.js";

describe("provider response helpers", () => {
  it("preserves an abort when the response has no readable body", async () => {
    const controller = new AbortController();
    const reason = new Error("aborted before body read");
    controller.abort(reason);

    await expect(readBoundedResponseText(new Response(null), 1, controller.signal)).rejects.toBe(
      reason,
    );
  });

  it("does not wait for a stalled cancellation after a response exceeds its byte bound", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.of(1, 2));
      },
      cancel() {
        return new Promise<void>(() => {});
      },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      readBoundedResponseText(new Response(body), 1).then(
        () => ({ status: "fulfilled" as const }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      ),
      new Promise<{ readonly status: "timeout" }>((resolve) => {
        timer = setTimeout(() => resolve({ status: "timeout" }), 100);
      }),
    ]);
    if (timer) clearTimeout(timer);

    expect(outcome).toMatchObject({ status: "rejected" });
    if (outcome.status === "rejected") {
      expect(outcome.error).toBeInstanceOf(RangeError);
    }
  });
});
