import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { PCM16_16K_MONO } from "../packages/core/dist/index.js";
import { createSarvamTtsProvider } from "../packages/providers/dist/index.js";

interface NegativeRecord {
  readonly name: string;
  readonly status: "passed" | "failed";
  readonly observedCode?: string;
  readonly detail?: string;
}

loadLocalEnv();

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const apiKey = requiredEnv("SARVAM_API_KEY");
  const timeoutMs = positiveInteger("SARVAM_TTS_NEGATIVE_TIMEOUT_MS", 15_000);
  const outputDir = resolve(
    process.env.SARVAM_TTS_NEGATIVE_OUTPUT_DIR?.trim() ||
      fileURLToPath(new URL("../local/sarvam-tts-negative/", import.meta.url)),
    timestampDirectory(),
  );
  mkdirSync(outputDir, { recursive: true });

  const records: NegativeRecord[] = [];
  records.push(await runInvalidApiKey(apiKey, timeoutMs));
  records.push(await runLiveCancellation(apiKey, timeoutMs));
  records.push(await runConnectionAbort(apiKey, timeoutMs));
  writeFileSync(resolve(outputDir, "manifest.json"), `${JSON.stringify({ records }, null, 2)}\n`);

  console.log(
    `Sarvam live negative checks: ${records.filter((record) => record.status === "passed").length}/${records.length} passed`,
  );
  console.log(`Manifest: ${resolve(outputDir, "manifest.json")}`);
  if (records.some((record) => record.status === "failed")) {
    throw new Error("one or more negative checks failed; see manifest.json");
  }
}

async function runInvalidApiKey(apiKey: string, timeoutMs: number): Promise<NegativeRecord> {
  const provider = createSarvamTtsProvider({
    apiKey: `${apiKey}.invalid-for-negative-test`,
    voiceId: "shubh",
    language: "en-IN",
  });
  let session: Awaited<ReturnType<typeof provider.openSession>> | undefined;
  try {
    session = await provider.openSession({
      sessionId: "sarvam_negative_auth" as never,
      turnId: "sarvam_negative_auth_turn" as never,
      voice: "shubh",
      format: PCM16_16K_MONO,
    });
    await session.sendText("authentication failure probe");
    await withTimeout(session.finish(), timeoutMs);
    return {
      name: "invalid API key is rejected",
      status: "failed",
      detail: "the provider completed synthesis with an intentionally invalid key",
    };
  } catch (error) {
    return {
      name: "invalid API key is rejected",
      status: "passed",
      observedCode: errorCode(error),
      detail: errorMessage(error),
    };
  } finally {
    await session?.cancel().catch(() => undefined);
  }
}

async function runLiveCancellation(apiKey: string, timeoutMs: number): Promise<NegativeRecord> {
  const provider = createSarvamTtsProvider({ apiKey, voiceId: "shubh", language: "en-IN" });
  let session: Awaited<ReturnType<typeof provider.openSession>> | undefined;
  try {
    session = await withTimeout(
      provider.openSession({
        sessionId: "sarvam_negative_cancel" as never,
        turnId: "sarvam_negative_cancel_turn" as never,
        voice: "shubh",
        format: PCM16_16K_MONO,
      }),
      timeoutMs,
    );
    await session.sendText(
      "This is a deliberately cancellable streaming turn. The adapter must close the socket cleanly when the caller barges in.",
    );
    await withTimeout(session.cancel(), timeoutMs);
    return { name: "live cancellation closes the stream", status: "passed" };
  } catch (error) {
    return {
      name: "live cancellation closes the stream",
      status: "failed",
      observedCode: errorCode(error),
      detail: errorMessage(error),
    };
  } finally {
    await session?.cancel().catch(() => undefined);
  }
}

async function runConnectionAbort(apiKey: string, timeoutMs: number): Promise<NegativeRecord> {
  const controller = new AbortController();
  const provider = createSarvamTtsProvider({
    apiKey,
    url: "ws://127.0.0.1:1/unreachable",
  });
  const opening = provider.openSession({
    sessionId: "sarvam_negative_abort" as never,
    turnId: "sarvam_negative_abort_turn" as never,
    voice: "shubh",
    format: PCM16_16K_MONO,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 50).unref?.();
  try {
    await withTimeout(opening, timeoutMs);
    return {
      name: "aborted connection fails without hanging",
      status: "failed",
      detail: "the unreachable connection unexpectedly opened",
    };
  } catch (error) {
    return {
      name: "aborted connection fails without hanging",
      status: "passed",
      observedCode: errorCode(error),
      detail: errorMessage(error),
    };
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function timestampDirectory(): string {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
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
