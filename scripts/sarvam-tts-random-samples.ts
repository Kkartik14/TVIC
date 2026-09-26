import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomInt } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { PCM16_16K_MONO, type TtsEvent } from "../packages/core/dist/index.js";
import {
  SARVAM_TTS_LANGUAGES,
  SARVAM_TTS_VOICES,
  createSarvamTtsProvider,
  type SarvamTtsLanguage,
  type SarvamTtsVoice,
} from "../packages/providers/dist/index.js";

const LANGUAGE_TEXT: Record<SarvamTtsLanguage, string> = {
  "hi-IN": "नमस्ते! यह TVIC का लाइव वॉइस स्ट्रीमिंग परीक्षण है।",
  "bn-IN": "নমস্কার! এটি TVIC-এর লাইভ ভয়েস স্ট্রিমিং পরীক্ষা।",
  "ta-IN": "வணக்கம்! இது TVIC நேரடி குரல் ஸ்ட்ரீமிங் சோதனை.",
  "te-IN": "నమస్కారం! ఇది TVIC ప్రత్యక్ష వాయిస్ స్ట్రీమింగ్ పరీక్ష.",
  "gu-IN": "નમસ્તે! આ TVIC લાઇવ વૉઇસ સ્ટ્રીમિંગ પરીક્ષણ છે.",
  "kn-IN": "ನಮಸ್ಕಾರ! ಇದು TVIC ನೇರ ಧ್ವನಿ ಸ್ಟ್ರೀಮಿಂಗ್ ಪರೀಕ್ಷೆ.",
  "ml-IN": "നമസ്കാരം! ഇത് TVIC തത്സമയ ശബ്ദ സ്ട്രീമിംഗ് പരിശോധനയാണ്.",
  "mr-IN": "नमस्कार! ही TVIC ची थेट व्हॉइस स्ट्रीमिंग चाचणी आहे.",
  "pa-IN": "ਸਤ ਸ੍ਰੀ ਅਕਾਲ! ਇਹ TVIC ਦੀ ਲਾਈਵ ਵੌਇਸ ਸਟ੍ਰੀਮਿੰਗ ਜਾਂਚ ਹੈ।",
  "od-IN": "ନମସ୍କାର! ଏହା TVIC ଲାଇଭ୍ ଭଏସ୍ ଷ୍ଟ୍ରିମିଂ ପରୀକ୍ଷଣ।",
  "en-IN": "Hello! This is a live TVIC voice streaming test.",
};

interface SampleRecord {
  readonly index: number;
  readonly voice: SarvamTtsVoice;
  readonly language: SarvamTtsLanguage;
  readonly text: string;
  readonly status: "passed" | "failed";
  readonly file: string;
  readonly chunks?: number;
  readonly audioBytes?: number;
  readonly durationMs?: number;
  readonly error?: string;
}

loadLocalEnv();

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const apiKey = requiredEnv("SARVAM_API_KEY");
  const count = positiveInteger("SARVAM_TTS_SAMPLE_COUNT", 10);
  if (count > SARVAM_TTS_VOICES.length || count > SARVAM_TTS_LANGUAGES.length) {
    throw new Error(
      `SARVAM_TTS_SAMPLE_COUNT must be at most ${Math.min(SARVAM_TTS_VOICES.length, SARVAM_TTS_LANGUAGES.length)}`,
    );
  }
  const timeoutMs = positiveInteger("SARVAM_TTS_SAMPLE_TIMEOUT_MS", 30_000);
  const outputRoot = process.env.SARVAM_TTS_OUTPUT_DIR?.trim()
    ? resolve(process.env.SARVAM_TTS_OUTPUT_DIR)
    : fileURLToPath(new URL("../local/sarvam-tts-samples/", import.meta.url));
  const outputDir = resolve(outputRoot, timestampDirectory());
  mkdirSync(outputDir, { recursive: true });

  const voices = shuffle(SARVAM_TTS_VOICES).slice(0, count);
  const languages = shuffle(SARVAM_TTS_LANGUAGES).slice(0, count);
  const records: SampleRecord[] = [];

  console.log(`Generating ${count} random Sarvam Bulbul v3 samples in ${outputDir}`);

  for (let index = 0; index < count; index += 1) {
    const voice = voices[index] as SarvamTtsVoice;
    const language = languages[index] as SarvamTtsLanguage;
    const text = LANGUAGE_TEXT[language];
    const file = `${String(index + 1).padStart(2, "0")}-${voice}-${language}.wav`;
    try {
      const result = await synthesize({ apiKey, voice, language, text, timeoutMs });
      writeFileSync(resolve(outputDir, file), pcm16ToWav(result.bytes));
      records.push({
        index: index + 1,
        voice,
        language,
        text,
        status: "passed",
        file,
        chunks: result.chunks,
        audioBytes: result.bytes.byteLength,
        durationMs: result.durationMs,
      });
      console.log(
        `- ${file}: passed (${result.chunks} chunks, ${result.bytes.byteLength} PCM bytes, ${result.durationMs}ms)`,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      records.push({
        index: index + 1,
        voice,
        language,
        text,
        status: "failed",
        file,
        error: detail,
      });
      console.error(`- ${file}: failed (${detail})`);
    }
    writeManifest(outputDir, records);
  }

  const passed = records.filter((record) => record.status === "passed").length;
  console.log(`Sarvam random sample result: ${passed}/${count} passed`);
  console.log(`Manifest: ${resolve(outputDir, "manifest.json")}`);
  if (passed !== count) throw new Error(`${count - passed} sample(s) failed; see manifest.json`);
}

interface SynthesisResult {
  readonly bytes: Uint8Array;
  readonly chunks: number;
  readonly durationMs: number;
}

async function synthesize(options: {
  readonly apiKey: string;
  readonly voice: SarvamTtsVoice;
  readonly language: SarvamTtsLanguage;
  readonly text: string;
  readonly timeoutMs: number;
}): Promise<SynthesisResult> {
  const provider = createSarvamTtsProvider({
    apiKey: options.apiKey,
    voiceId: options.voice,
    language: options.language,
  });
  const session = await provider.openSession({
    sessionId: `sarvam_random_sample_${options.voice}` as never,
    turnId: `sarvam_random_sample_${options.language}` as never,
    voice: options.voice,
    format: PCM16_16K_MONO,
  });
  let closed = false;
  try {
    await session.sendText(options.text);
    await withTimeout(session.finish(), options.timeoutMs);
    const chunks: Uint8Array[] = [];
    let committed = 0;
    for await (const event of session.events) {
      observeTtsEvent(
        event,
        (bytes) => chunks.push(bytes),
        () => {
          committed += 1;
        },
      );
    }
    const audio = concatBytes(chunks);
    if (audio.byteLength === 0 || audio.byteLength % 2 !== 0 || committed !== 1) {
      throw new Error(
        `invalid output chunks=${chunks.length}, bytes=${audio.byteLength}, committed=${committed}`,
      );
    }
    closed = true;
    return {
      bytes: audio,
      chunks: chunks.length,
      durationMs: Math.round((audio.byteLength / 2 / PCM16_16K_MONO.sampleRateHz) * 1_000),
    };
  } finally {
    if (!closed) await session.cancel();
  }
}

function observeTtsEvent(
  event: TtsEvent,
  onAudio: (bytes: Uint8Array) => void,
  onCommitted: () => void,
): void {
  if (event.type === "media.audio.chunk") onAudio(event.audio.bytes);
  if (event.type === "media.audio.committed") onCommitted();
}

function pcm16ToWav(bytes: Uint8Array): Buffer {
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

function writeManifest(outputDir: string, records: readonly SampleRecord[]): void {
  writeFileSync(
    resolve(outputDir, "manifest.json"),
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        provider: "sarvam-tts",
        model: "bulbul:v3",
        format: "pcm_s16le",
        sampleRateHz: PCM16_16K_MONO.sampleRateHz,
        channels: PCM16_16K_MONO.channels,
        records,
      },
      null,
      2,
    )}\n`,
  );
}

function shuffle<T>(values: readonly T[]): T[] {
  const output = [...values];
  for (let index = output.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(index + 1);
    [output[index], output[swapIndex]] = [output[swapIndex] as T, output[index] as T];
  }
  return output;
}

function timestampDirectory(): string {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`operation timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required env var ${name}`);
  return value;
}

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function loadLocalEnv(): void {
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
