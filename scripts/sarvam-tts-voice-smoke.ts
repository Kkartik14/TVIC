import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PCM16_16K_MONO, type TtsEvent } from "../packages/core/dist/index.js";
import { SARVAM_TTS_VOICES, createSarvamTtsProvider } from "../packages/providers/dist/index.js";

loadLocalEnv();

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const apiKey = requiredEnv("SARVAM_API_KEY");
  const language = process.env.SARVAM_TTS_LANGUAGE ?? "en-IN";
  const text = process.env.SARVAM_TTS_TEXT ?? "TVIC voice streaming test.";
  const timeoutMs = positiveNumber("SARVAM_TTS_VOICE_SMOKE_TIMEOUT_MS", 30_000);
  const failures: string[] = [];

  console.log(
    `Sarvam Bulbul v3 voice smoke: ${SARVAM_TTS_VOICES.length} voices, language=${language}`,
  );

  for (const voice of SARVAM_TTS_VOICES) {
    try {
      const provider = createSarvamTtsProvider({ apiKey, language, voiceId: voice });
      const session = await provider.openSession({
        sessionId: "sarvam_tts_voice_smoke" as never,
        turnId: `sarvam_tts_voice_${voice}` as never,
        voice,
        format: PCM16_16K_MONO,
      });
      let finished = false;
      try {
        await session.sendText(text);
        await withTimeout(session.finish(), timeoutMs);
        finished = true;
        let chunks = 0;
        let bytes = 0;
        let committed = 0;
        for await (const event of session.events) {
          observeTtsEvent(
            event,
            (count) => {
              chunks += 1;
              bytes += count;
            },
            () => {
              committed += 1;
            },
          );
        }
        if (chunks === 0 || bytes === 0 || committed !== 1) {
          throw new Error(
            `invalid output chunks=${chunks}, bytes=${bytes}, committed=${committed}`,
          );
        }
        console.log(`- ${voice}: passed (${chunks} chunks, ${bytes} bytes)`);
      } finally {
        if (!finished) await session.cancel();
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      failures.push(`${voice}: ${detail}`);
      console.error(`- ${voice}: failed (${detail})`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`Sarvam voice smoke failed for ${failures.length} voice(s)`);
  }
  console.log(`Sarvam voice smoke passed: ${SARVAM_TTS_VOICES.length}/${SARVAM_TTS_VOICES.length}`);
}

function observeTtsEvent(
  event: TtsEvent,
  onAudio: (bytes: number) => void,
  onCommitted: () => void,
): void {
  if (event.type === "media.audio.chunk") onAudio(event.audio.bytes.byteLength);
  if (event.type === "media.audio.committed") onCommitted();
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

function positiveNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
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
