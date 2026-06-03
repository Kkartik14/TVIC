/** Wraps raw little-endian 16-bit PCM in a minimal WAV header so a browser <audio> can play it. */
export function pcm16ToWav(pcm: Uint8Array, sampleRate: number, channels = 1): Buffer {
  // Defensive: the header stores sampleRate and byteRate as uint32, so a non-integer or
  // out-of-range rate would throw inside writeUInt32LE. Reject it explicitly instead.
  if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0 || sampleRate > 192000) {
    throw new Error(`Unsupported WAV sample rate: ${sampleRate}`);
  }
  if (channels !== 1 && channels !== 2) {
    throw new Error(`Unsupported WAV channel count: ${channels}`);
  }
  const blockAlign = channels * 2;
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcm.byteLength;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  Buffer.from(pcm).copy(buffer, 44);

  return buffer;
}
