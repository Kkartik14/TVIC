import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PCM16_16K_MONO, type TtsEvent, type TtsStream } from "../packages/core/dist/index.js";
import {
  createSarvamTtsHttpStreamProvider,
  createSarvamTtsRestProvider,
} from "../packages/providers/dist/index.js";

export type SarvamHttpTransport = "rest" | "http-stream";

export interface SarvamHttpAudioResult {
  readonly bytes: Uint8Array;
  readonly chunks: number;
  readonly durationMs: number;
}

export async function synthesizeSarvamHttpAudio(options: {
  readonly apiKey: string;
  readonly transport: SarvamHttpTransport;
  readonly voice: string;
  readonly language: string;
  readonly text: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly timeoutMs: number;
}): Promise<SarvamHttpAudioResult> {
  const provider =
    options.transport === "rest"
      ? createSarvamTtsRestProvider({
          apiKey: options.apiKey,
          voiceId: options.voice,
          language: options.language,
        })
      : createSarvamTtsHttpStreamProvider({
          apiKey: options.apiKey,
          voiceId: options.voice,
          language: options.language,
        });
  const controller = new AbortController();
  let stream: TtsStream | undefined;
  const operation = (async (): Promise<SarvamHttpAudioResult> => {
    stream = await provider.synthesize({
      sessionId: options.sessionId as never,
      turnId: options.turnId as never,
      format: PCM16_16K_MONO,
      text: options.text,
      stream: true,
      signal: controller.signal,
    });
    return collectSarvamHttpAudio(stream);
  })();

  try {
    return await withTimeout(operation, options.timeoutMs, () => {
      controller.abort();
      void stream?.cancel();
    });
  } catch (error) {
    controller.abort();
    await stream?.cancel().catch(() => undefined);
    throw error;
  }
}

async function collectSarvamHttpAudio(stream: TtsStream): Promise<SarvamHttpAudioResult> {
  const chunks: Uint8Array[] = [];
  let committed = 0;
  try {
    for await (const event of stream.events) {
      observeSarvamHttpEvent(event, chunks, () => {
        committed += 1;
      });
    }
  } finally {
    if (committed !== 1) await stream.cancel().catch(() => undefined);
  }

  const bytes = concatBytes(chunks);
  if (bytes.byteLength === 0 || bytes.byteLength % 2 !== 0 || committed !== 1) {
    throw new Error(
      `invalid output chunks=${chunks.length}, bytes=${bytes.byteLength}, committed=${committed}`,
    );
  }
  return {
    bytes,
    chunks: chunks.length,
    durationMs: Math.round((bytes.byteLength / 2 / PCM16_16K_MONO.sampleRateHz) * 1_000),
  };
}

function observeSarvamHttpEvent(
  event: TtsEvent,
  chunks: Uint8Array[],
  onCommitted: () => void,
): void {
  if (event.type === "media.audio.chunk") {
    if (
      event.audio.format.encoding !== PCM16_16K_MONO.encoding ||
      event.audio.format.sampleRateHz !== PCM16_16K_MONO.sampleRateHz ||
      event.audio.format.channels !== PCM16_16K_MONO.channels
    ) {
      throw new Error("provider returned audio outside TVIC's PCM16/16kHz/mono contract");
    }
    chunks.push(event.audio.bytes);
  }
  if (event.type === "media.audio.committed") onCommitted();
}

export function pcm16ToWav(bytes: Uint8Array): Buffer {
  const data = Buffer.from(bytes);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.byteLength, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(PCM16_16K_MONO.sampleRateHz, 24);
  header.writeUInt32LE(PCM16_16K_MONO.sampleRateHz * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.byteLength, 40);
  return Buffer.concat([header, data]);
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

export function isRetriable(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "retriable" in error) {
    return (error as { retriable?: unknown }).retriable === true;
  }
  return false;
}

export function isCreditExhausted(error: unknown): boolean {
  return /credit|balance|quota/.test(errorMessage(error).toLowerCase());
}

export function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer`);
  return value;
}

export function nonNegativeInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${name} must be a non-negative integer`);
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
    if (!match || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = parseEnvValue(match[2] ?? "");
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

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          onTimeout();
          reject(new Error(`operation timed out after ${timeoutMs}ms`));
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
