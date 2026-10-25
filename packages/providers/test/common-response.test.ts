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

  it("bounds the number of response chunks even when they carry no bytes", async () => {
    let remaining = 65_537;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (remaining === 0) {
          controller.close();
          return;
        }
        remaining -= 1;
        controller.enqueue(new Uint8Array());
      },
    });

    await expect(readBoundedResponseText(new Response(body), 1)).rejects.toThrow(/chunk limit/i);
  });

  it("decodes UTF-8 split across tiny chunks and ignores empty chunks", async () => {
    const expected = "fragmented 🎤 response";
    const encoded = new TextEncoder().encode(expected);
    const chunks: Uint8Array[] = [new Uint8Array()];
    for (const byte of encoded) {
      chunks.push(Uint8Array.of(byte), new Uint8Array());
    }
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });

    await expect(readBoundedResponseText(new Response(body), encoded.byteLength)).resolves.toBe(
      expected,
    );
  });
});
