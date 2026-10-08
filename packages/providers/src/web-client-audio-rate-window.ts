const INPUT_RATE_WINDOW_MS = 2_000;
const INPUT_RATE_WINDOW_SECONDS = INPUT_RATE_WINDOW_MS / 1_000;

/** Enforces byte and frame budgets over a two-second rolling input window. */
export class WebClientAudioRateWindow {
  readonly #maxBytesPerSecond: number;
  readonly #maxFramesPerSecond: number;
  #sampleTimes = new Float64Array(0);
  #sampleByteCounts = new Float64Array(0);
  #head = 0;
  #count = 0;
  #bytesInWindow = 0;

  constructor(maxBytesPerSecond: number, maxFramesPerSecond: number) {
    this.#maxBytesPerSecond = maxBytesPerSecond;
    this.#maxFramesPerSecond = maxFramesPerSecond;
  }

  accept(bytes: number, nowMonotonicMs: number): boolean {
    const maxBytesInWindow = this.#maxBytesPerSecond * INPUT_RATE_WINDOW_SECONDS;
    const maxFramesInWindow = this.#maxFramesPerSecond * INPUT_RATE_WINDOW_SECONDS;
    if (!Number.isFinite(maxBytesInWindow) || !Number.isFinite(maxFramesInWindow)) return false;
    this.#expire(nowMonotonicMs - INPUT_RATE_WINDOW_MS);
    const withinByteLimit = this.#bytesInWindow + bytes <= maxBytesInWindow;
    const withinFrameLimit = this.#count + 1 <= maxFramesInWindow;
    if (!withinByteLimit || !withinFrameLimit) return false;
    this.#append(nowMonotonicMs, bytes);
    return true;
  }

  #expire(cutoff: number): void {
    // The window is open at the cutoff so an exact-limit cadence is admitted.
    while (this.#count > 0) {
      const oldestAt = this.#sampleTimes[this.#head];
      if (oldestAt === undefined || !(oldestAt <= cutoff)) break;
      this.#bytesInWindow -= this.#sampleByteCounts[this.#head] ?? 0;
      this.#head += 1;
      if (this.#head === this.#sampleTimes.length) this.#head = 0;
      this.#count -= 1;
    }
    if (this.#count === 0) {
      this.#head = 0;
      this.#bytesInWindow = 0;
    }
  }

  #append(at: number, bytes: number): void {
    if (this.#count === this.#sampleTimes.length) {
      const capacity = Math.max(8, this.#sampleTimes.length * 2);
      const nextTimes = new Float64Array(capacity);
      const nextByteCounts = new Float64Array(capacity);
      for (let index = 0; index < this.#count; index += 1) {
        let oldIndex = this.#head + index;
        if (oldIndex >= this.#sampleTimes.length) oldIndex -= this.#sampleTimes.length;
        nextTimes[index] = this.#sampleTimes[oldIndex] ?? 0;
        nextByteCounts[index] = this.#sampleByteCounts[oldIndex] ?? 0;
      }
      this.#sampleTimes = nextTimes;
      this.#sampleByteCounts = nextByteCounts;
      this.#head = 0;
    }
    let index = this.#head + this.#count;
    if (index >= this.#sampleTimes.length) index -= this.#sampleTimes.length;
    this.#sampleTimes[index] = at;
    this.#sampleByteCounts[index] = bytes;
    this.#count += 1;
    this.#bytesInWindow += bytes;
  }
}
