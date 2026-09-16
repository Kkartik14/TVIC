import type { TranscriptEvent } from "@tvic/core";

import { closeAsyncIterator } from "./pipeline-helpers.js";

interface GenerationIteratorState {
  readonly iterator: AsyncIterator<TranscriptEvent>;
  done: boolean;
  closePromise?: Promise<void>;
}

/** Owns per-generation iterator cleanup so every exit path is bounded and idempotent. */
export class GenerationIteratorRegistry {
  readonly #states = new Map<number, GenerationIteratorState>();

  set(generation: number, iterator: AsyncIterator<TranscriptEvent>): void {
    this.#states.set(generation, { iterator, done: false });
  }

  markDone(generation: number): void {
    const state = this.#states.get(generation);
    if (state) state.done = true;
  }

  delete(generation: number): void {
    this.#states.delete(generation);
  }

  close(generation: number): Promise<void> {
    const state = this.#states.get(generation);
    if (!state || state.done) return Promise.resolve();
    if (!state.closePromise) {
      state.closePromise = closeAsyncIterator(
        state.iterator,
        `STT generation ${generation} iterator cleanup timed out`,
      );
    }
    return state.closePromise;
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.#states.keys()].map((generation) => this.close(generation)));
  }
}
