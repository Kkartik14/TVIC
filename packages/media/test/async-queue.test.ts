import { describe, expect, it } from "vitest";

import {
  ASYNC_QUEUE_DEFAULT_MAX_BUFFERED,
  AsyncQueue,
  AsyncQueueConsumerError,
} from "../src/index.js";

/**
 * Normative queue transitions (Team 1 table, Team 2 implementation):
 * open/first-claim/push-full/next/return/close/fail/second-claim.
 */
describe("AsyncQueue contract", () => {
  it("defaults to a finite bound", () => {
    expect(ASYNC_QUEUE_DEFAULT_MAX_BUFFERED).toBe(1_024);
    const queue = new AsyncQueue<number>();
    for (let i = 0; i < 1_024; i += 1) expect(queue.push(i)).toBe(true);
    expect(queue.push(1_024)).toBe(false);
  });

  it("claims the first iterator and throws a stable error on the second", () => {
    const queue = new AsyncQueue<number>();
    const first = queue[Symbol.asyncIterator]();
    expect(() => queue[Symbol.asyncIterator]()).toThrowError(AsyncQueueConsumerError);
    try {
      queue[Symbol.asyncIterator]();
      expect.unreachable("second claim must throw");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("async_queue.consumer_already_claimed");
      expect((error as { name?: string }).name).toBe("AsyncQueueConsumerError");
      expect(error).toBeInstanceOf(AsyncQueueConsumerError);
    }
    void first;
  });

  it("releases the claim when the iterator settles, allowing sequential reuse", async () => {
    const queue = new AsyncQueue<number>();
    queue.push(1);
    queue.close();
    const seen: number[] = [];
    for await (const value of queue) seen.push(value);
    expect(seen).toEqual([1]);
    // Post-terminal sequential subscribe succeeds (live split is what throws).
    const second = queue[Symbol.asyncIterator]();
    await expect(second.next()).resolves.toMatchObject({ done: true });
  });

  it("producer close() drains buffered values before done", async () => {
    const queue = new AsyncQueue<number>();
    queue.push(1);
    queue.push(2);
    queue.close();
    const seen: number[] = [];
    for await (const value of queue) seen.push(value);
    expect(seen).toEqual([1, 2]);
  });

  it("consumer return() discards buffered values and closes permanently", async () => {
    const queue = new AsyncQueue<number>();
    queue.push(1);
    queue.push(2);
    const iter = queue[Symbol.asyncIterator]();
    await iter.next();
    await iter.return?.();
    // Buffered remainder discarded; later pushes refused.
    expect(queue.push(3)).toBe(false);
    await expect(iter.next()).resolves.toMatchObject({ done: true });
  });

  it("fail() records the first error, discards buffered values, rejects all next()", async () => {
    const queue = new AsyncQueue<number>();
    queue.push(1);
    const first = new Error("first");
    queue.fail(first);
    queue.fail(new Error("second"));
    const iter = queue[Symbol.asyncIterator]();
    await expect(iter.next()).rejects.toBe(first);
  });

  it("throw() terminates pending consumers before releasing the claim", async () => {
    const queue = new AsyncQueue<number>();
    const iter = queue[Symbol.asyncIterator]();
    const pending = iter.next();
    const error = new Error("consumer stopped");

    await expect(iter.throw?.(error)).rejects.toBe(error);
    await expect(pending).rejects.toBe(error);
    const next = queue[Symbol.asyncIterator]();
    await expect(next.next()).rejects.toBe(error);
  });

  it("close() and fail() are idempotent with first-terminal-wins", async () => {
    const queue = new AsyncQueue<number>();
    queue.close();
    queue.close();
    queue.fail(new Error("late"));
    const iter = queue[Symbol.asyncIterator]();
    await expect(iter.next()).resolves.toMatchObject({ done: true });
  });
});
