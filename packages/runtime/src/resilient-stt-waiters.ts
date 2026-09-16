/** Small condition variables for the journal worker and graceful close path. */
export class ResilientSttWaiters {
  #resolveWake: (() => void) | undefined;
  readonly #drainWaiters: Array<() => void> = [];

  signalWork(): void {
    this.#resolveWake?.();
    this.#resolveWake = undefined;
  }

  async waitForWork(ready: () => boolean): Promise<void> {
    if (ready()) return;
    const wake = new Promise<void>((resolve) => {
      this.#resolveWake = resolve;
    });
    await wake;
  }

  async waitForJournalDrain(drained: () => boolean): Promise<void> {
    if (drained()) return;
    await new Promise<void>((resolve) => {
      this.#drainWaiters.push(resolve);
    });
  }

  resolveDrainWaiters(): void {
    for (const resolve of this.#drainWaiters.splice(0)) {
      resolve();
    }
  }
}
