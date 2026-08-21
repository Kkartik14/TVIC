class TvicPcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pending = new Float32Array(0);
    this.position = 0;
    this.step = sampleRate / 16000;
    this.chunk = new Int16Array(320);
    this.chunkPosition = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input || input.length === 0) return true;
    const combined = new Float32Array(this.pending.length + input.length);
    combined.set(this.pending);
    combined.set(input, this.pending.length);
    while (this.position + 1 < combined.length) {
      const left = Math.floor(this.position);
      const fraction = this.position - left;
      const sample = combined[left] * (1 - fraction) + combined[left + 1] * fraction;
      this.chunk[this.chunkPosition++] = Math.max(
        -32768,
        Math.min(32767, Math.round(sample * 32767)),
      );
      this.position += this.step;
      if (this.chunkPosition === this.chunk.length) {
        this.port.postMessage(this.chunk.buffer, [this.chunk.buffer]);
        this.chunk = new Int16Array(320);
        this.chunkPosition = 0;
      }
    }
    const consumed = Math.floor(this.position);
    this.pending = combined.slice(consumed);
    this.position -= consumed;
    return true;
  }
}

registerProcessor("tvic-pcm-capture", TvicPcmCaptureProcessor);
