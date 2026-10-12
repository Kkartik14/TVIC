import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PCM16_16K_MONO, type TtsEvent, type TtsStream } from "../packages/core/dist/index.js";
import {
  createSarvamTtsHttpStreamProvider,
  createSarvamTtsRestProvider,
} from "../packages/providers/dist/index.js";
import { MAX_NODE_TIMER_DELAY_MS, parsePositiveInteger } from "./sarvam-tts-live-limits.js";

export type SarvamHttpTransport = "rest" | "http-stream";

export interface SarvamHttpAudioMetrics {
  readonly audioBytes: number;
  readonly chunks: number;
  readonly durationMs: number;
}

export interface SarvamHttpAudioResult extends SarvamHttpAudioMetrics {
  readonly bytes: Uint8Array;
}

interface SarvamHttpSynthesisOptions {
  readonly apiKey: string;
  readonly transport: SarvamHttpTransport;
  readonly model?: string;
  readonly voice: string;
  readonly language: string;
  readonly text: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly timeoutMs: number;
}

export async function cancelSarvamHttpStream(
  stream: TtsStream | undefined,
  timeoutMs = 1_000,
): Promise<void> {
  if (!stream) return;
  const cancellation = Promise.resolve()
    .then(() => stream.cancel())
    .catch(() => undefined);
  await Promise.race([cancellation, delay(timeoutMs)]);
}

export function synthesizeSarvamHttpAudio(
  options: SarvamHttpSynthesisOptions & { readonly collectAudio: false },
): Promise<SarvamHttpAudioMetrics>;
export function synthesizeSarvamHttpAudio(
  options: SarvamHttpSynthesisOptions & { readonly collectAudio?: true },
): Promise<SarvamHttpAudioResult>;
export async function synthesizeSarvamHttpAudio(
  options: SarvamHttpSynthesisOptions & { readonly collectAudio?: boolean },
): Promise<SarvamHttpAudioResult | SarvamHttpAudioMetrics> {
  const provider =
    options.transport === "rest"
      ? createSarvamTtsRestProvider({
          apiKey: options.apiKey,
          ...(options.model ? { modelId: options.model } : {}),
          voiceId: options.voice,
          language: options.language,
        })
      : createSarvamTtsHttpStreamProvider({
          apiKey: options.apiKey,
          ...(options.model ? { modelId: options.model } : {}),
          voiceId: options.voice,
          language: options.language,
        });
  const controller = new AbortController();
  let stream: TtsStream | undefined;
  const operation = (async (): Promise<SarvamHttpAudioResult | SarvamHttpAudioMetrics> => {
    stream = await provider.synthesize({
      sessionId: options.sessionId as never,
      turnId: options.turnId as never,
      format: PCM16_16K_MONO,
      text: options.text,
      stream: true,
      signal: controller.signal,
    });
    return collectSarvamHttpAudio(stream, options.collectAudio !== false);
  })();

  try {
    return await withTimeout(operation, options.timeoutMs, () => {
      controller.abort();
    });
  } catch (error) {
    controller.abort();
    await cancelSarvamHttpStream(stream);
    throw error;
  }
}

async function collectSarvamHttpAudio(
  stream: TtsStream,
  collectAudio: boolean,
): Promise<SarvamHttpAudioResult | SarvamHttpAudioMetrics> {
  const audioChunks: Uint8Array[] | undefined = collectAudio ? [] : undefined;
  let chunkCount = 0;
  let audioBytes = 0;
  let committed = 0;
  try {
    for await (const event of stream.events) {
      observeSarvamHttpEvent(
        event,
        audioChunks,
        () => {
          committed += 1;
        },
        (byteLength) => {
          chunkCount += 1;
          audioBytes += byteLength;
        },
      );
    }
  } finally {
    if (committed !== 1) await cancelSarvamHttpStream(stream);
  }

  if (audioBytes === 0 || audioBytes % 2 !== 0 || committed !== 1) {
    throw new Error(
      `invalid output chunks=${chunkCount}, bytes=${audioBytes}, committed=${committed}`,
    );
  }
  const metrics: SarvamHttpAudioMetrics = {
    audioBytes,
    chunks: chunkCount,
    durationMs: Math.round((audioBytes / 2 / PCM16_16K_MONO.sampleRateHz) * 1_000),
  };
  return audioChunks ? { ...metrics, bytes: concatBytes(audioChunks) } : metrics;
}

function observeSarvamHttpEvent(
  event: TtsEvent,
  chunks: Uint8Array[] | undefined,
  onCommitted: () => void,
  onAudioChunk: (byteLength: number) => void,
): void {
  if (event.type === "media.audio.chunk") {
    if (
      event.audio.format.encoding !== PCM16_16K_MONO.encoding ||
      event.audio.format.sampleRateHz !== PCM16_16K_MONO.sampleRateHz ||
      event.audio.format.channels !== PCM16_16K_MONO.channels
    ) {
      throw new Error("provider returned audio outside TVIC's PCM16/16kHz/mono contract");
    }
    onAudioChunk(event.audio.bytes.byteLength);
    chunks?.push(event.audio.bytes);
  }
  if (event.type === "media.audio.committed") onCommitted();
}

export function pcm16ToWav(bytes: Uint8Array): Buffer {
  const wav = Buffer.allocUnsafe(44 + bytes.byteLength);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + bytes.byteLength, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(PCM16_16K_MONO.sampleRateHz, 24);
  wav.writeUInt32LE(PCM16_16K_MONO.sampleRateHz * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(bytes.byteLength, 40);
  wav.set(bytes, 44);
  return wav;
}

export function hasValidPcm16Wav(file: string, audioBytes: number | undefined): boolean {
  if (
    typeof audioBytes !== "number" ||
    !Number.isSafeInteger(audioBytes) ||
    audioBytes <= 0 ||
    audioBytes % 2 !== 0
  ) {
    return false;
  }
  const expectedFileBytes = 44 + audioBytes;
  try {
    if (statSync(file).size !== expectedFileBytes) return false;
    const descriptor = openSync(file, "r");
    const wav = Buffer.alloc(44);
    let bytesRead: number;
    try {
      bytesRead = readSync(descriptor, wav, 0, wav.byteLength, 0);
    } finally {
      closeSync(descriptor);
    }
    return (
      bytesRead === wav.byteLength &&
      wav.toString("ascii", 0, 4) === "RIFF" &&
      wav.readUInt32LE(4) === 36 + audioBytes &&
      wav.toString("ascii", 8, 12) === "WAVE" &&
      wav.toString("ascii", 12, 16) === "fmt " &&
      wav.readUInt32LE(16) === 16 &&
      wav.readUInt16LE(20) === 1 &&
      wav.readUInt16LE(22) === PCM16_16K_MONO.channels &&
      wav.readUInt32LE(24) === PCM16_16K_MONO.sampleRateHz &&
      wav.readUInt32LE(28) === PCM16_16K_MONO.sampleRateHz * 2 &&
      wav.readUInt16LE(32) === 2 &&
      wav.readUInt16LE(34) === 16 &&
      wav.toString("ascii", 36, 40) === "data" &&
      wav.readUInt32LE(40) === audioBytes
    );
  } catch {
    return false;
  }
}

export class StartPacer {
  #tail: Promise<void> = Promise.resolve();
  #nextAllowedAt = 0;

  constructor(readonly intervalMs: number) {}

  async wait(): Promise<void> {
    const previous = this.#tail;
    let release: () => void = () => undefined;
    this.#tail = new Promise<void>((resolveRelease) => {
      release = resolveRelease;
    });
    await previous;
    try {
      const waitMs = Math.max(0, this.#nextAllowedAt - Date.now());
      if (waitMs > 0) await delay(waitMs);
      this.#nextAllowedAt = Date.now() + this.intervalMs;
    } finally {
      release();
    }
  }
}

export function percentile(values: readonly number[], ratio: number): number {
  if (values.length === 0) return 0;
  return (
    values[Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * ratio) - 1))] ?? 0
  );
}

export function parseSelection(
  raw: string | undefined,
  allowed: readonly string[],
  name: string,
): string[] {
  const values = (raw ?? allowed.join(","))
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.length === 0) throw new Error(`${name} selection cannot be empty`);
  for (const value of values) {
    if (!allowed.includes(value)) throw new Error(`unsupported ${name} entry: ${value}`);
  }
  if (new Set(values).size !== values.length)
    throw new Error(`${name} selection contains duplicates`);
  return values;
}

export function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function positiveInteger(
  name: string,
  fallback: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  return parsePositiveInteger(name, process.env[name], fallback, maximum);
}

export function timerMilliseconds(name: string, fallback: number): number {
  return positiveInteger(name, fallback, MAX_NODE_TIMER_DELAY_MS);
}

export function nonNegativeInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > 10)
    throw new Error(`${name} must be a non-negative integer no greater than 10`);
  return value;
}

export function booleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (raw === "1" || raw.toLowerCase() === "true") return true;
  if (raw === "0" || raw.toLowerCase() === "false") return false;
  throw new Error(`${name} must be true/false or 1/0`);
}

export function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required env var ${name}`);
  return value;
}

export function timestampDirectory(): string {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

export function loadLocalEnv(): void {
  if (process.env.NODE_ENV === "production" || process.env.TVIC_ENV === "production") return;
  let source: string;
  try {
    source = readFileSync(fileURLToPath(new URL("../.env", import.meta.url)), "utf8");
  } catch {
    return;
  }
  for (const line of source.split(/\r?\n/u)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/u.exec(line);
    const name = match?.[1];
    if (!name || process.env[name] !== undefined) continue;
    process.env[name] = parseEnvValue(match?.[2] ?? "");
  }
}

function parseEnvValue(raw: string): string {
  if (raw.length >= 2) {
    const first = raw[0];
    const last = raw.at(-1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return raw.slice(1, -1);
    }
  }
  const comment = raw.indexOf(" #");
  return comment >= 0 ? raw.slice(0, comment).trimEnd() : raw;
}

export async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void | Promise<void>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`operation timed out after ${timeoutMs}ms`));
          try {
            void Promise.resolve(onTimeout()).catch(() => undefined);
          } catch {
            // Ignore cleanup errors after the timeout wins.
          }
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
