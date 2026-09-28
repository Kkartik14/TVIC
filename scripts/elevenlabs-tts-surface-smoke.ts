import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PCM16_16K_MONO, type TtsEvent } from "@tvic/core";
import {
  PROVIDER_CATALOG,
  createElevenLabsDialogueMultiContextProvider,
  createElevenLabsMultiContextProvider,
  createElevenLabsTtsHttpStreamProvider,
  createElevenLabsTtsRestProvider,
  type ElevenLabsDialogueSynthesisRequest,
} from "../packages/providers/dist/index.js";

type SmokeStatus = "passed" | "blocked" | "failed";
type SmokeResult = {
  readonly name: string;
  readonly status: SmokeStatus;
  readonly detail: string;
};

loadLocalEnv();

void main().catch((error: unknown) => {
  console.error(describeError(error));
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const apiKey = requiredEnv("ELEVENLABS_API_KEY");
  const voiceId = requiredEnv("ELEVENLABS_VOICE_ID");
  const configuredModels = process.env.ELEVENLABS_SURFACE_MODELS?.split(",")
    .map((model) => model.trim())
    .filter(Boolean);
  const models = configuredModels?.length ? configuredModels : PROVIDER_CATALOG.elevenlabs.models;
  const results: SmokeResult[] = [];
  const text = "TVIC ElevenLabs transport test.";

  for (const model of models) {
    for (const transport of ["rest", "http-stream"] as const) {
      results.push(
        await runCase(`${transport}:${model}`, async () => {
          const providerOptions = { apiKey, voiceId, modelId: model, fetchImpl: fetch };
          const provider =
            transport === "rest"
              ? createElevenLabsTtsRestProvider(providerOptions)
              : createElevenLabsTtsHttpStreamProvider(providerOptions);
          const events = await collectEvents(
            await provider.synthesize({
              sessionId: `elevenlabs_http_${transport}_${model}` as never,
              turnId: `elevenlabs_http_turn_${model}` as never,
              text,
              format: PCM16_16K_MONO,
              model,
              stream: true,
            }),
          );
          assertCompleted(events);
          return `${events.length} events, ${audioBytes(events)} PCM bytes`;
        }),
      );
    }
  }

  const timestampModel = models.find((model) => !model.startsWith("eleven_v3")) ?? models[0];
  if (timestampModel) {
    for (const transport of ["rest", "http-stream"] as const) {
      results.push(
        await runCase(`timestamped-${transport}:${timestampModel}`, async () => {
          const providerOptions = { apiKey, voiceId, modelId: timestampModel };
          const provider =
            transport === "rest"
              ? createElevenLabsTtsRestProvider(providerOptions)
              : createElevenLabsTtsHttpStreamProvider(providerOptions);
          const events = await collectEvents(
            await provider.synthesize({
              sessionId: `elevenlabs_timestamp_${transport}` as never,
              turnId: `elevenlabs_timestamp_turn_${transport}` as never,
              text,
              format: PCM16_16K_MONO,
              model: timestampModel,
              timestamps: true,
              stream: true,
            }),
          );
          assertCompleted(events);
          if (!events.some((event) => event.type === "tts.alignment")) {
            throw new Error("timestamped response contained no alignment event");
          }
          return `${events.length} events with alignment`;
        }),
      );
    }
  }

  const dialogueModel = models.find((model) => model === "eleven_v3") ?? "eleven_v3";
  results.push(
    await runCase("dialogue-http-explicit", async () => {
      const provider = createElevenLabsTtsRestProvider({ apiKey, voiceId, modelId: dialogueModel });
      const request: ElevenLabsDialogueSynthesisRequest = {
        sessionId: "elevenlabs_dialogue_http" as never,
        turnId: "elevenlabs_dialogue_http_turn" as never,
        format: PCM16_16K_MONO,
        model: dialogueModel,
        stream: false,
        inputs: [{ text: "Hello from TVIC.", voiceId }],
      };
      const events = await collectEvents(await provider.synthesizeDialogue(request));
      assertCompleted(events);
      return `${events.length} events`;
    }),
  );

  results.push(
    await runCase("multi-context-tts-websocket", async () => {
      const provider = createElevenLabsMultiContextProvider({
        apiKey,
        voiceId,
        modelId: "eleven_flash_v2_5",
        protocol: "tts",
      });
      const connection = await provider.openConnection();
      const context = await connection.openContext({
        contextId: "tvic-tts-context",
        sessionId: "elevenlabs_multi_tts" as never,
        turnId: "elevenlabs_multi_tts_turn" as never,
        voice: voiceId,
        model: "eleven_flash_v2_5",
        format: PCM16_16K_MONO,
      });
      await context.sendText("Hello from the TTS multi-context path.");
      await context.finish();
      const events = await collectEvents(context);
      await connection.close();
      assertCompleted(events);
      return `${events.length} events`;
    }),
  );

  results.push(
    await runCase("multi-context-dialogue-websocket", async () => {
      const provider = createElevenLabsDialogueMultiContextProvider({
        apiKey,
        modelId: "eleven_v3_conversational",
        dialogueVoices: [voiceId],
      });
      const connection = await provider.openConnection();
      const context = await connection.openContext({
        contextId: "tvic-dialogue-context",
        sessionId: "elevenlabs_multi_dialogue" as never,
        turnId: "elevenlabs_multi_dialogue_turn" as never,
        voice: voiceId,
        voices: [voiceId],
        model: "eleven_v3_conversational",
        format: PCM16_16K_MONO,
      });
      await context.sendDialogueTurn("Hello from the Dialogue multi-context path.");
      await context.finish();
      const events = await collectEvents(context);
      await connection.close();
      assertCompleted(events);
      return `${events.length} events`;
    }),
  );

  console.log("ElevenLabs TTS surface summary:");
  for (const result of results) {
    console.log(`- ${result.name}: ${result.status} (${result.detail})`);
  }
  if (results.some((result) => result.status === "failed")) process.exitCode = 1;
  if (
    results.some((result) => result.status === "blocked") &&
    process.env.LIVE_SMOKE_ALLOW_BLOCKED !== "1"
  ) {
    process.exitCode = 1;
  }
}

async function collectEvents(stream: {
  readonly events: AsyncIterable<TtsEvent>;
}): Promise<TtsEvent[]> {
  const events: TtsEvent[] = [];
  for await (const event of stream.events) events.push(event);
  return events;
}

function assertCompleted(events: readonly TtsEvent[]): void {
  if (!events.some((event) => event.type === "media.audio.chunk")) {
    throw new Error("provider returned no audio chunks");
  }
  if (!events.some((event) => event.type === "media.audio.committed")) {
    throw new Error("provider returned no committed event");
  }
}

function audioBytes(events: readonly TtsEvent[]): number {
  return events.reduce(
    (total, event) =>
      total + (event.type === "media.audio.chunk" ? event.audio.bytes.byteLength : 0),
    0,
  );
}

async function runCase(name: string, operation: () => Promise<string>): Promise<SmokeResult> {
  const startedAt = Date.now();
  try {
    const detail = await withTimeout(
      operation(),
      readPositiveNumber("ELEVENLABS_SMOKE_TIMEOUT_MS", 45_000),
    );
    return { name, status: "passed", detail: `${detail}; ${Date.now() - startedAt}ms` };
  } catch (error) {
    return {
      name,
      status: isBlockedError(error) ? "blocked" : "failed",
      detail: `${describeError(error)}; ${Date.now() - startedAt}ms`,
    };
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required env var ${name}`);
  return value;
}

function isBlockedError(error: unknown): boolean {
  const value = describeError(error).toLowerCase();
  return [
    "rate_limited",
    "quota",
    "credit",
    "balance",
    "unauthorized",
    "forbidden",
    "permission",
    "access denied",
    "too many concurrent",
  ].some((needle) => value.includes(needle));
}

function describeError(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const value = error as { readonly code?: unknown; readonly message?: unknown };
    if (typeof value.code === "string" && typeof value.message === "string") {
      return `${value.code}: ${value.message}`;
    }
  }
  return error instanceof Error ? error.message : String(error);
}

function readPositiveNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
  return value;
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
    if (timer !== undefined) clearTimeout(timer);
  }
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
