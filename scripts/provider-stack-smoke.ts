import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type WsWebSocket from "ws";
import type { RawData } from "ws";

const requireFromRuntimePackage = createRequire(
  new URL("../packages/voice-runtime/package.json", import.meta.url),
);
const WebSocket = requireFromRuntimePackage("ws") as typeof WsWebSocket;

import {
  PCM16_16K_MONO,
  isTvicError,
  nowTimestamp,
  type LlmUsage,
  type TerminalSession,
  type TerminalSessionStatus,
  type TranscriptEvent,
} from "../packages/core/dist/index.js";
import { splitPcm16leFrames } from "../packages/media/dist/index.js";
import {
  createCartesiaTtsProvider,
  createDeepgramSttProvider,
  createGroqChatLlmProvider,
  PROVIDER_API_VERSIONS,
  PROVIDER_CATALOG,
} from "../packages/providers/dist/index.js";
import { createSttSession } from "../packages/runtime/dist/index.js";
import {
  createNodeMediaPlane as createPublicNodeMediaPlane,
  createVoiceAgent as createPublicVoiceAgent,
  createWebClientAudioProvider as createPublicWebClientAudioProvider,
  createDeepgramSttProvider as createPublicDeepgramSttProvider,
  createGroqChatLlmProvider as createPublicGroqChatLlmProvider,
  createCartesiaTtsProvider as createPublicCartesiaTtsProvider,
  PCM16_16K_MONO as PUBLIC_PCM16_16K_MONO,
  type LLMProvider,
  type TerminalSession as PublicTerminalSession,
  type TextToSpeechProvider,
} from "../packages/voice-runtime/dist/index.js";

const DEFAULT_GROQ_MODEL = "openai/gpt-oss-20b";
const CHUNK_DURATION_MS = 20;
const OPERATION_TIMEOUT_MS = 30_000;
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const CANCELLATION_TEXT =
  "This is a deliberately longer cancellation probe so the provider has an active generation to stop.";
const EVIDENCE_PATH = fileURLToPath(
  new URL("../local/task-2/provider-stack-smoke.json", import.meta.url),
);
const VOICE_RUNTIME_VERSION = (
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../packages/voice-runtime/package.json", import.meta.url)),
      "utf8",
    ),
  ) as { readonly version: string }
).version;
let smokePhase:
  | "configuration"
  | "fixture_synthesis"
  | "transcription"
  | "direct_completion"
  | "output_synthesis"
  | "cancellation_probe"
  | "managed_transport"
  | "managed_transport_start"
  | "managed_websocket_connect"
  | "managed_session_start"
  | "managed_session_ready"
  | "managed_input_audio"
  | "managed_turn_run"
  | "managed_graceful_completion"
  | "managed_finalization"
  | "managed_output_validation"
  | "evidence_write" = "configuration";

interface SmokeConfig {
  readonly groqModel: string;
  readonly sttModel?: string;
  readonly sttLanguage?: string;
  readonly cartesiaModel?: string;
  readonly groqUrl?: string;
}

interface AudioResult {
  readonly bytes: Uint8Array;
  readonly chunks: number;
  readonly durationMs: number;
  readonly inputCharacters: number;
}

interface SttResult {
  readonly text: string;
  readonly partials: number;
  readonly finals: number;
  readonly endpoints: number;
}

interface LlmResult {
  readonly text: string;
  readonly tokenEvents: number;
  readonly usage?: LlmUsage;
}

interface CancellationResult {
  readonly audioChunksBeforeCancel: number;
  readonly requestCharacters: number;
}

interface TransportResult {
  readonly transport: "web-client-audio";
  readonly sessionReady: boolean;
  readonly inputFrames: number;
  readonly outputAudioFrames: number;
  readonly outputAudioBytes: number;
  readonly assistantMessages: number;
  readonly assistantTextCharacters: number;
  readonly outputCommits: number;
  readonly cleanShutdown: boolean;
  readonly managedUsage: {
    readonly llmInputTokens: number;
    readonly llmOutputTokens: number;
    readonly llmCompletionsWithUsage: number;
    readonly llmCompletionsWithoutUsage: number;
    readonly ttsInputCharacters: number;
  };
  readonly finalSession: {
    readonly sessionId: string;
    readonly callId?: string;
    readonly status: TerminalSessionStatus;
    readonly terminalSource?: TerminalSession["terminalSource"];
    readonly startedAt: string;
    readonly endedAt: string;
  };
}

interface SmokeEvidence {
  readonly schemaVersion: 2;
  readonly recordedAt: string;
  readonly runtimeVersion: string;
  readonly runtimeArtifact: "workspace-build";
  readonly durationMs: number;
  readonly harness: "provider-stack-smoke";
  readonly execution: {
    readonly mode: "reference-stack";
    readonly topology: "cascaded";
    readonly runtimePath: "public-managed-voice-agent";
    readonly directAdapterProbes: "diagnostic-only";
    readonly managedTransport: "one-turn-live-provider";
    readonly latencySlo: "not_measured";
  };
  readonly stack: {
    readonly stt: {
      readonly provider: "deepgram";
      readonly model: string;
      readonly language?: string;
      readonly adapterVersion: string;
      readonly apiVersion: "v1 listen";
    };
    readonly llm: {
      readonly provider: "groq";
      readonly model: string;
      readonly adapterVersion: string;
      readonly apiVersion: "OpenAI-compatible v1 Chat Completions";
    };
    readonly tts: {
      readonly provider: "cartesia";
      readonly model: string;
      readonly adapterVersion: string;
      readonly apiVersion: string;
    };
  };
  readonly results: {
    readonly inputAudioChunks: number;
    readonly inputAudioDurationMs: number;
    readonly sttPartials: number;
    readonly sttFinals: number;
    readonly sttEndpoints: number;
    readonly llmTokenEvents: number;
    readonly outputAudioChunks: number;
    readonly outputAudioDurationMs: number;
    readonly cancellationAudioChunksBeforeCancel: number;
    readonly transport: TransportResult;
    readonly usage: {
      readonly deepgramInputAudioMs: number;
      readonly groqInputTokens: number | null;
      readonly groqOutputTokens: number | null;
      readonly groqUsageComplete: boolean;
      readonly cartesiaTtsCharacters: number;
      readonly cartesiaCreditsApprox: number | null;
    };
    readonly costEstimate: {
      readonly currency: "USD";
      readonly totalUsd: number | null;
      readonly deepgramUsd: number | null;
      readonly groqUsd: number | null;
      readonly cartesiaProPlanEquivalentUsd: number | null;
      readonly pricingReviewedAt: "2026-09-29";
      readonly notes: readonly string[];
    };
  };
}

loadLocalEnv();

void main().catch((error: unknown) => {
  const code = errorCode(error);
  if (code) {
    console.error(`Provider stack smoke failed during ${smokePhase} (${code})`);
  } else if (error instanceof MissingEnvironmentVariableError) {
    console.error(`Provider stack smoke is missing ${error.variableName}`);
  } else if (error instanceof SmokeDiagnosticError) {
    console.error(error.message);
  } else {
    console.error(`Provider stack smoke failed during ${smokePhase} (details suppressed)`);
  }
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const startedAtMs = performance.now();
  const config = loadConfig();
  const cartesia = createCartesiaTtsProvider({
    apiKey: requiredEnv("CARTESIA_API_KEY"),
    voiceId: requiredEnv("CARTESIA_VOICE_ID"),
    ...(config.cartesiaModel ? { modelId: config.cartesiaModel } : {}),
  });
  const deepgram = createDeepgramSttProvider({ apiKey: requiredEnv("DEEPGRAM_API_KEY") });
  const groq = createGroqChatLlmProvider({
    apiKey: requiredEnv("GROQ_API_KEY"),
    ...(config.groqUrl ? { url: config.groqUrl } : {}),
  });

  const sttModel = config.sttModel ?? PROVIDER_CATALOG.deepgram.defaultModel;
  const cartesiaModel = config.cartesiaModel ?? PROVIDER_CATALOG.cartesia.defaultModel;
  console.log(
    `Provider stack smoke: Deepgram/${sttModel} -> ` +
      `Groq/${config.groqModel} -> Cartesia/${cartesiaModel}`,
  );
  console.log(
    `Provider/API versions: Deepgram/${deepgram.version} + v1 listen, ` +
      `Groq/${groq.version} + OpenAI-compatible v1 Chat Completions, ` +
      `Cartesia/${cartesia.version} + ${PROVIDER_API_VERSIONS.cartesia}`,
  );

  // Generate the STT fixture through the selected TTS provider so this check is
  // self-contained. Audio and transcript text stay in memory and are never logged
  // or written to the release evidence artifact.
  smokePhase = "fixture_synthesis";
  const inputAudio = await synthesize(
    cartesia,
    "Please tell me today's opening hours.",
    "smoke_input",
  );
  smokePhase = "transcription";
  const transcription = await transcribe(deepgram, inputAudio.bytes, config);
  if (!transcription.text) {
    throw new Error("Deepgram returned no final transcript for the generated fixture");
  }
  smokePhase = "direct_completion";
  const response = await complete(groq, transcription.text, config);
  if (!response.text || response.tokenEvents === 0) {
    throw new Error("Groq returned no streamed text for the transcript");
  }
  smokePhase = "output_synthesis";
  const outputAudio = await synthesize(cartesia, response.text, "smoke_output");
  smokePhase = "cancellation_probe";
  const cancellation = await cancelInFlight(cartesia);
  smokePhase = "managed_transport";
  const transport = await runTransportSmoke(config, inputAudio.bytes);
  const runtimeDurationMs = Math.round(performance.now() - startedAtMs);
  const groqUsageComplete =
    response.usage !== undefined &&
    transport.managedUsage.llmCompletionsWithUsage > 0 &&
    transport.managedUsage.llmCompletionsWithoutUsage === 0;
  const groqInputTokens = groqUsageComplete
    ? response.usage!.inputTokens + transport.managedUsage.llmInputTokens
    : null;
  const groqOutputTokens = groqUsageComplete
    ? response.usage!.outputTokens + transport.managedUsage.llmOutputTokens
    : null;
  const deepgramInputAudioMs = inputAudio.durationMs + transport.inputFrames * CHUNK_DURATION_MS;
  const cartesiaTtsCharacters =
    inputAudio.inputCharacters +
    outputAudio.inputCharacters +
    cancellation.requestCharacters +
    transport.managedUsage.ttsInputCharacters;
  const costs = estimateCost({
    sttModel,
    ...(config.sttLanguage ? { sttLanguage: config.sttLanguage } : {}),
    groqModel: config.groqModel,
    cartesiaModel,
    deepgramInputAudioMs,
    groqInputTokens,
    groqOutputTokens,
    cartesiaTtsCharacters,
  });
  const evidence: SmokeEvidence = {
    schemaVersion: 2,
    recordedAt: new Date().toISOString(),
    runtimeVersion: VOICE_RUNTIME_VERSION,
    runtimeArtifact: "workspace-build",
    durationMs: runtimeDurationMs,
    harness: "provider-stack-smoke",
    execution: {
      mode: "reference-stack",
      topology: "cascaded",
      runtimePath: "public-managed-voice-agent",
      directAdapterProbes: "diagnostic-only",
      managedTransport: "one-turn-live-provider",
      latencySlo: "not_measured",
    },
    stack: {
      stt: {
        provider: "deepgram",
        model: sttModel,
        ...(config.sttLanguage ? { language: config.sttLanguage } : {}),
        adapterVersion: deepgram.version,
        apiVersion: "v1 listen",
      },
      llm: {
        provider: "groq",
        model: config.groqModel,
        adapterVersion: groq.version,
        apiVersion: "OpenAI-compatible v1 Chat Completions",
      },
      tts: {
        provider: "cartesia",
        model: cartesiaModel,
        adapterVersion: cartesia.version,
        apiVersion: PROVIDER_API_VERSIONS.cartesia,
      },
    },
    results: {
      inputAudioChunks: inputAudio.chunks,
      inputAudioDurationMs: Math.round(inputAudio.durationMs),
      sttPartials: transcription.partials,
      sttFinals: transcription.finals,
      sttEndpoints: transcription.endpoints,
      llmTokenEvents: response.tokenEvents,
      outputAudioChunks: outputAudio.chunks,
      outputAudioDurationMs: Math.round(outputAudio.durationMs),
      cancellationAudioChunksBeforeCancel: cancellation.audioChunksBeforeCancel,
      transport,
      usage: {
        deepgramInputAudioMs: Math.round(deepgramInputAudioMs),
        groqInputTokens,
        groqOutputTokens,
        groqUsageComplete,
        cartesiaTtsCharacters,
        cartesiaCreditsApprox: costs.cartesiaCreditsApprox,
      },
      costEstimate: {
        currency: "USD",
        totalUsd: costs.totalUsd,
        deepgramUsd: costs.deepgramUsd,
        groqUsd: costs.groqUsd,
        cartesiaProPlanEquivalentUsd: costs.cartesiaProPlanEquivalentUsd,
        pricingReviewedAt: "2026-09-29",
        notes: [
          "Deepgram is priced only for explicit English (en or en-US) Nova-3 usage; other or default language settings remain unpriced.",
          "Groq uses reported token counts and the published rate for the selected GPT-OSS model; unknown or missing usage remains unpriced.",
          "Cartesia credits use approximately one credit per submitted character and a prorated $5/100,000-credit Pro-plan equivalent; this is not an invoice or marginal charge.",
          "Estimates exclude taxes, plan balances, and provider-side billing adjustments.",
        ],
      },
    },
  };
  smokePhase = "evidence_write";
  writeEvidence(evidence);

  console.log(
    `Provider stack path passed (workspace build ${VOICE_RUNTIME_VERSION}, ${runtimeDurationMs}ms): ` +
      `input_audio=${inputAudio.chunks} chunks/${Math.round(inputAudio.durationMs)}ms, ` +
      `stt_final=${transcription.finals}, stt_partial=${transcription.partials}, ` +
      `stt_endpoint=${transcription.endpoints}, llm_token_events=${response.tokenEvents}, ` +
      `output_audio=${outputAudio.chunks} chunks/${Math.round(outputAudio.durationMs)}ms, ` +
      `cancel_probe=${cancellation.audioChunksBeforeCancel} chunks, ` +
      `transport_input=${transport.inputFrames} frames, ` +
      `transport_output=${transport.outputAudioFrames} frames, ` +
      `final=${transport.finalSession.status}/${transport.finalSession.terminalSource ?? "unknown"}`,
  );
}

function loadConfig(): SmokeConfig {
  return {
    groqModel: optionalEnv("GROQ_MODEL") ?? optionalEnv("LLM_MODEL") ?? DEFAULT_GROQ_MODEL,
    ...(optionalEnv("STT_MODEL") ? { sttModel: optionalEnv("STT_MODEL") } : {}),
    ...(optionalEnv("STT_LANGUAGE") ? { sttLanguage: optionalEnv("STT_LANGUAGE") } : {}),
    ...(optionalEnv("CARTESIA_MODEL") ? { cartesiaModel: optionalEnv("CARTESIA_MODEL") } : {}),
    ...(optionalEnv("GROQ_API_URL") ? { groqUrl: optionalEnv("GROQ_API_URL") } : {}),
  };
}

interface CostEstimateInput {
  readonly sttModel: string;
  readonly sttLanguage?: string;
  readonly groqModel: string;
  readonly cartesiaModel: string;
  readonly deepgramInputAudioMs: number;
  readonly groqInputTokens: number | null;
  readonly groqOutputTokens: number | null;
  readonly cartesiaTtsCharacters: number;
}

function estimateCost(input: CostEstimateInput): {
  readonly totalUsd: number | null;
  readonly deepgramUsd: number | null;
  readonly groqUsd: number | null;
  readonly cartesiaProPlanEquivalentUsd: number | null;
  readonly cartesiaCreditsApprox: number | null;
} {
  const deepgramLanguage = input.sttLanguage?.toLowerCase();
  const deepgramUsd =
    input.sttModel === "nova-3" && (deepgramLanguage === "en" || deepgramLanguage === "en-us")
      ? roundUsd((input.deepgramInputAudioMs / 60_000) * 0.0048)
      : null;
  const groqRates: Readonly<Record<string, { readonly input: number; readonly output: number }>> = {
    "openai/gpt-oss-20b": { input: 0.075, output: 0.3 },
    "openai/gpt-oss-120b": { input: 0.15, output: 0.6 },
  };
  const groqRate = groqRates[input.groqModel];
  const groqUsd =
    groqRate && input.groqInputTokens !== null && input.groqOutputTokens !== null
      ? roundUsd(
          (input.groqInputTokens * groqRate.input + input.groqOutputTokens * groqRate.output) /
            1_000_000,
        )
      : null;
  const cartesiaCreditsApprox = ["sonic-3", "sonic-3.6"].includes(input.cartesiaModel)
    ? input.cartesiaTtsCharacters
    : null;
  const cartesiaProPlanEquivalentUsd =
    cartesiaCreditsApprox === null ? null : roundUsd((cartesiaCreditsApprox / 100_000) * 5);
  return {
    deepgramUsd,
    groqUsd,
    cartesiaProPlanEquivalentUsd,
    cartesiaCreditsApprox,
    totalUsd:
      deepgramUsd === null || groqUsd === null || cartesiaProPlanEquivalentUsd === null
        ? null
        : roundUsd(deepgramUsd + groqUsd + cartesiaProPlanEquivalentUsd),
  };
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

class MissingEnvironmentVariableError extends Error {
  constructor(readonly variableName: string) {
    super(`Missing required provider environment variable: ${variableName}`);
  }
}

class SmokeDiagnosticError extends Error {}

async function synthesize(
  provider: ReturnType<typeof createCartesiaTtsProvider>,
  text: string,
  turnId: string,
): Promise<AudioResult> {
  const opening = provider.synthesize({
    sessionId: "provider_stack_smoke" as never,
    turnId: turnId as never,
    text,
    format: PCM16_16K_MONO,
    stream: true,
  });
  let stream: Awaited<typeof opening>;
  try {
    stream = await withTimeout(opening, OPERATION_TIMEOUT_MS, "Cartesia synthesis startup");
  } catch (error) {
    void opening
      .then((lateStream) =>
        withTimeout(
          lateStream.cancel(),
          OPERATION_TIMEOUT_MS,
          "Late Cartesia synthesis cancellation",
        ).catch(() => undefined),
      )
      .catch(() => undefined);
    throw error;
  }
  const chunks: Uint8Array[] = [];
  let durationMs = 0;
  let chunkCount = 0;
  let totalBytes = 0;
  const consume = (async (): Promise<void> => {
    for await (const event of stream.events) {
      if (event.type !== "media.audio.chunk") continue;
      const bytes = new Uint8Array(event.audio.bytes);
      if (totalBytes + bytes.byteLength > MAX_AUDIO_BYTES) {
        throw new Error("Cartesia smoke output exceeded the bounded audio limit");
      }
      chunks.push(bytes);
      totalBytes += bytes.byteLength;
      chunkCount += 1;
      durationMs += event.audio.durationMs;
    }
  })();
  try {
    await withTimeout(consume, OPERATION_TIMEOUT_MS, "Cartesia synthesis");
  } catch (error) {
    await stream.cancel().catch(() => undefined);
    await consume.catch(() => undefined);
    throw error;
  }
  await stream.cancel().catch(() => undefined);
  const bytes = concat(chunks);
  if (bytes.byteLength === 0) throw new Error("Cartesia returned no audio");
  return { bytes, chunks: chunkCount, durationMs, inputCharacters: text.length };
}

async function cancelInFlight(
  provider: ReturnType<typeof createCartesiaTtsProvider>,
): Promise<CancellationResult> {
  const text = CANCELLATION_TEXT;
  const opening = provider.synthesize({
    sessionId: "provider_stack_smoke" as never,
    turnId: "smoke_cancel" as never,
    text,
    format: PCM16_16K_MONO,
    stream: true,
  });
  let stream: Awaited<typeof opening>;
  try {
    stream = await withTimeout(opening, OPERATION_TIMEOUT_MS, "Cartesia cancellation startup");
  } catch (error) {
    void opening
      .then((lateStream) =>
        withTimeout(
          lateStream.cancel(),
          OPERATION_TIMEOUT_MS,
          "Late Cartesia cancellation-probe cancellation",
        ).catch(() => undefined),
      )
      .catch(() => undefined);
    throw error;
  }
  let audioChunksBeforeCancel = 0;
  let cancelCalls = 0;
  const consume = (async (): Promise<void> => {
    for await (const event of stream.events) {
      if (event.type !== "media.audio.chunk") continue;
      audioChunksBeforeCancel += 1;
      if (cancelCalls > 0) continue;
      cancelCalls += 1;
      await withTimeout(stream.cancel(), OPERATION_TIMEOUT_MS, "Cartesia in-flight cancellation");
    }
  })();
  try {
    await withTimeout(consume, OPERATION_TIMEOUT_MS, "Cartesia cancellation drain");
  } catch (error) {
    await stream.cancel().catch(() => undefined);
    await consume.catch(() => undefined);
    throw error;
  }
  if (cancelCalls !== 1 || audioChunksBeforeCancel === 0) {
    throw new Error("Cartesia cancellation probe did not cancel after an audio chunk");
  }
  return { audioChunksBeforeCancel, requestCharacters: text.length };
}

async function transcribe(
  provider: ReturnType<typeof createDeepgramSttProvider>,
  audio: Uint8Array,
  config: SmokeConfig,
): Promise<SttResult> {
  const session = await createSttSession({
    provider,
    format: PCM16_16K_MONO,
    ...(config.sttModel ? { model: config.sttModel } : {}),
    ...(config.sttLanguage ? { language: config.sttLanguage } : {}),
    interimResults: true,
    openTimeoutMs: OPERATION_TIMEOUT_MS,
  });
  let partials = 0;
  let finals = 0;
  let endpoints = 0;
  let finalText = "";
  let resolveFinal: (() => void) | undefined;
  const finalSeen = new Promise<void>((resolve) => {
    resolveFinal = resolve;
  });
  const consume = consumeStt(session.events, (event) => {
    if (event.type === "stt.partial") partials += 1;
    if (event.type === "stt.final") {
      finals += 1;
      finalText = `${finalText} ${event.text}`.trim();
      resolveFinal?.();
      resolveFinal = undefined;
    }
    if (event.type === "stt.endpoint") endpoints += 1;
  });

  try {
    for (const chunk of splitPcm16leFrames(audio, PCM16_16K_MONO, CHUNK_DURATION_MS)) {
      await session.pushPcm16(chunk);
    }
    await withTimeout(session.commit(), OPERATION_TIMEOUT_MS, "Deepgram commit");
    await withTimeout(finalSeen, OPERATION_TIMEOUT_MS, "Deepgram final transcript");
  } finally {
    await session.close().catch(() => undefined);
  }
  await consume;
  return { text: finalText, partials, finals, endpoints };
}

async function consumeStt(
  events: AsyncIterable<TranscriptEvent>,
  observe: (event: TranscriptEvent) => void,
): Promise<void> {
  for await (const event of events) observe(event);
}

async function complete(
  provider: ReturnType<typeof createGroqChatLlmProvider>,
  transcript: string,
  config: SmokeConfig,
): Promise<LlmResult> {
  const completion = await provider.complete({
    sessionId: "provider_stack_smoke" as never,
    turnId: "smoke_llm" as never,
    model: config.groqModel,
    messages: [
      { role: "system", content: "Answer briefly and naturally for a phone caller." },
      { role: "user", content: transcript },
    ],
    stream: true,
    // The selected GPT-OSS model emits hidden reasoning tokens before its
    // user-visible answer. Leave enough completion budget for both; a 96-token
    // cap can legally end with an empty visible answer even when the request
    // succeeded.
    maxTokens: 512,
  });
  let text = "";
  let tokenEvents = 0;
  let usage: LlmUsage | undefined;
  const consume = (async (): Promise<void> => {
    for await (const event of completion.events) {
      if (event.type === "llm.token") {
        text += event.text;
        tokenEvents += 1;
      }
      if (event.type === "llm.failed") throw new Error("Groq returned a failed completion");
      if (event.type === "llm.completed" && !text) text = event.text;
      if (event.type === "llm.completed" && event.usage) usage = event.usage;
    }
  })();
  try {
    await withTimeout(consume, OPERATION_TIMEOUT_MS, "Groq completion");
  } catch (error) {
    await completion.cancel().catch(() => undefined);
    await consume.catch(() => undefined);
    throw error;
  }
  return { text: text.trim(), tokenEvents, ...(usage ? { usage } : {}) };
}

/**
 * Exercises the selected providers through the built public package bundle and the
 * real Node/WebSocket Web Client Audio transport. The client is a local test
 * peer, so no browser credentials or caller content leave the process.
 */
async function runTransportSmoke(
  config: SmokeConfig,
  inputAudio: Uint8Array,
): Promise<TransportResult> {
  const callId = "provider_stack_transport";
  const connectionEvents: string[] = [];
  const observedMessages: string[] = [];
  const managedUsage = {
    llmInputTokens: 0,
    llmOutputTokens: 0,
    llmCompletionsWithUsage: 0,
    llmCompletionsWithoutUsage: 0,
    ttsInputCharacters: 0,
  };
  const telephony = createPublicWebClientAudioProvider({
    heartbeatIntervalMs: 1_000,
    heartbeatTimeoutMs: 60_000,
    maxSessionDurationMs: 60_000,
    onConnectionEvent: (event) => {
      if (connectionEvents.length >= 16) return;
      connectionEvents.push(
        event.type === "session_ended" ? `${event.type}:${event.closeCode}` : event.type,
      );
    },
  });
  const stt = createPublicDeepgramSttProvider({ apiKey: requiredEnv("DEEPGRAM_API_KEY") });
  const llm = createPublicGroqChatLlmProvider({
    apiKey: requiredEnv("GROQ_API_KEY"),
    ...(config.groqUrl ? { url: config.groqUrl } : {}),
  });
  const tts = createPublicCartesiaTtsProvider({
    apiKey: requiredEnv("CARTESIA_API_KEY"),
    voiceId: requiredEnv("CARTESIA_VOICE_ID"),
    ...(config.cartesiaModel ? { modelId: config.cartesiaModel } : {}),
  });
  const observedLlm: LLMProvider = {
    name: llm.name,
    kind: llm.kind,
    version: llm.version,
    capabilities: llm.capabilities,
    async complete(request) {
      const completion = await llm.complete(request);
      const events = (async function* () {
        for await (const event of completion.events) {
          if (event.type === "llm.completed") {
            if (event.usage) {
              managedUsage.llmInputTokens += event.usage.inputTokens;
              managedUsage.llmOutputTokens += event.usage.outputTokens;
              managedUsage.llmCompletionsWithUsage += 1;
            } else {
              managedUsage.llmCompletionsWithoutUsage += 1;
            }
          }
          yield event;
        }
      })();
      return { events, cancel: () => completion.cancel() };
    },
  };
  const observedTts: TextToSpeechProvider = {
    name: tts.name,
    kind: tts.kind,
    version: tts.version,
    capabilities: tts.capabilities,
    async synthesize(request) {
      managedUsage.ttsInputCharacters += request.text.length;
      return tts.synthesize(request);
    },
  };
  const agent = createPublicVoiceAgent({
    id: "provider-stack-smoke-agent",
    name: "Provider Stack Smoke Agent",
    prompt: "Answer the caller briefly and naturally.",
    providers: { telephony, stt, llm: observedLlm, tts: observedTts },
    audio: { input: PUBLIC_PCM16_16K_MONO, output: PUBLIC_PCM16_16K_MONO },
    models: {
      stt: config.sttModel ?? PROVIDER_CATALOG.deepgram.defaultModel,
      llm: config.groqModel,
      tts: config.cartesiaModel ?? PROVIDER_CATALOG.cartesia.defaultModel,
    },
  });
  smokePhase = "managed_transport_start";

  let resolveStarted!: (value: {
    readonly sessionId: string;
    readonly run: Promise<unknown>;
    readonly finalSession: Promise<PublicTerminalSession>;
    readonly complete: () => Promise<PublicTerminalSession>;
  }) => void;
  let rejectStarted!: (error: unknown) => void;
  const started = new Promise<{
    readonly sessionId: string;
    readonly run: Promise<unknown>;
    readonly finalSession: Promise<PublicTerminalSession>;
    readonly complete: () => Promise<PublicTerminalSession>;
  }>((resolve, reject) => {
    resolveStarted = resolve;
    rejectStarted = reject;
  });
  const plane = createPublicNodeMediaPlane<{ readonly callId: string }>({
    host: "127.0.0.1",
    port: 0,
    path: "/provider-smoke/:callId",
    authorizeUpgrade: (_request, url, params) => {
      if (url.searchParams.get("token") !== "provider-stack-smoke") {
        return { ok: false, statusCode: 401 };
      }
      if (params.callId !== callId) {
        return { ok: false, statusCode: 403 };
      }
      return { ok: true, context: { callId } };
    },
    onConnection({ socket, upgradeContext }) {
      void (async () => {
        smokePhase = "managed_session_start";
        if (!upgradeContext) throw new Error("transport smoke authorization context missing");
        const now = nowTimestamp();
        const call = {
          id: upgradeContext.callId,
          provider: "web-client-audio",
          direction: "inbound",
          from: "smoke-client",
          to: "provider-stack-smoke",
          status: "connected",
          mediaTransport: { kind: "websocket", format: PUBLIC_PCM16_16K_MONO },
          createdAt: now,
          startedAt: now,
        } as never;
        const session = await agent.start({
          call,
          channel: "web_audio",
          ...(config.sttLanguage ? { sttLanguage: config.sttLanguage } : {}),
          textDelivery: "always",
          startupTimeoutMs: OPERATION_TIMEOUT_MS,
          callHandle: ({ sessionId, call: runtimeCall }) => {
            if (runtimeCall.id !== upgradeContext.callId) {
              throw new Error("transport smoke call identity mismatch");
            }
            telephony.attachWebSocket(socket, runtimeCall.id, sessionId);
            return telephony.accept({ call: runtimeCall });
          },
        });
        const run = Promise.resolve(session.run);
        void run.catch(() => undefined);
        resolveStarted({
          sessionId: String(session.sessionId),
          run,
          finalSession: session.finalSession,
          complete: session.complete,
        });
        smokePhase = "managed_session_ready";
      })().catch(rejectStarted);
    },
  });

  let client: WsWebSocket | undefined;
  let shutdownComplete = false;
  let sessionReady = false;
  let inputFrames = 0;
  let outputAudioFrames = 0;
  let outputAudioBytes = 0;
  let assistantMessages = 0;
  let assistantTextCharacters = 0;
  let outputCommits = 0;
  let commitSeen = false;
  let outputCommitId: string | undefined;
  let completionRequested = false;
  const shutdown = async (): Promise<void> => {
    const failures: unknown[] = [];
    const steps = [
      () =>
        client
          ? withTimeout(closeWebSocket(client), OPERATION_TIMEOUT_MS, "WebSocket client shutdown")
          : Promise.resolve(),
      () => withTimeout(agent.stop(), OPERATION_TIMEOUT_MS, "voice agent shutdown"),
      () => withTimeout(plane.stop(), OPERATION_TIMEOUT_MS, "media plane shutdown"),
    ];
    for (const stop of steps) {
      try {
        await stop();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "Provider smoke transport cleanup failed");
    }
    shutdownComplete = true;
  };
  try {
    smokePhase = "managed_transport_start";
    await plane.start();
    const address = plane.address;
    if (!address) throw new Error("provider smoke transport did not expose a listening address");
    smokePhase = "managed_websocket_connect";
    client = await withTimeout(
      connectWebSocket(
        `ws://127.0.0.1:${address.port}/provider-smoke/${callId}?token=provider-stack-smoke`,
      ),
      OPERATION_TIMEOUT_MS,
      "Web Client Audio transport connect",
    );
    smokePhase = "managed_session_ready";
    const session = await withTimeout(started, OPERATION_TIMEOUT_MS, "managed transport startup");
    let resolveCompletedCall!: () => void;
    let rejectCompletedCall!: (error: unknown) => void;
    const completedCall = new Promise<void>((resolve, reject) => {
      resolveCompletedCall = resolve;
      rejectCompletedCall = reject;
    });
    void completedCall.catch(() => undefined);
    const maybeCompleteCall = (): void => {
      if (assistantMessages === 0 || !commitSeen || !outputCommitId || completionRequested) return;
      completionRequested = true;
      smokePhase = "managed_graceful_completion";
      void (async () => {
        const finalSession = await session.complete();
        if (
          finalSession.status !== "completed" ||
          finalSession.terminalSource !== "normal_completion"
        ) {
          throw new Error("managed complete() did not persist a normal completed session");
        }
      })().then(resolveCompletedCall, rejectCompletedCall);
    };
    client.on("message", (data, isBinary) => {
      if (isBinary) {
        outputAudioFrames += 1;
        outputAudioBytes += rawDataByteLength(data);
        return;
      }
      const message = parseClientJson(data);
      if (!message) return;
      if (typeof message.type === "string" && observedMessages.length < 32) {
        observedMessages.push(message.type);
      }
      if (message.type === "session.ready" && message.sessionId === session.sessionId) {
        sessionReady = true;
      }
      if (message.type === "assistant.text") {
        assistantMessages += 1;
        if (typeof message.text === "string") assistantTextCharacters += message.text.length;
        maybeCompleteCall();
      }
      if (message.type === "output.commit" && typeof message.commitId === "string") {
        outputCommits += 1;
        commitSeen = true;
        outputCommitId = message.commitId;
        client?.send(JSON.stringify({ type: "output.playout_ack", commitId: message.commitId }));
        maybeCompleteCall();
      }
    });
    client.send(
      JSON.stringify({
        type: "session.start",
        protocolVersion: 1,
        mode: "push_to_talk",
        clientPlatform: "provider-stack-smoke",
        audioFormat: PUBLIC_PCM16_16K_MONO,
      }),
    );
    smokePhase = "managed_input_audio";
    await withTimeout(
      waitFor(() => sessionReady),
      OPERATION_TIMEOUT_MS,
      "Web Client Audio session start",
    );
    for (const chunk of splitPcm16leFrames(inputAudio, PUBLIC_PCM16_16K_MONO, CHUNK_DURATION_MS)) {
      inputFrames += 1;
      client.send(webClientAudioFrame(chunk, inputFrames));
      // Preserve the fixture's real-time cadence. Flooding every frame at once
      // lets delayed provider speech events arrive after the turn starts and
      // falsely exercises barge-in instead of the one-turn stack.
      await delay(CHUNK_DURATION_MS);
    }
    // Give the transport and provider event loop a bounded opportunity to
    // publish the final result for the last audio frame before the explicit
    // push-to-talk barrier is admitted.
    await delay(500);
    client.send(JSON.stringify({ type: "turn.end" }));
    smokePhase = "managed_turn_run";
    try {
      await withTimeout(completedCall, OPERATION_TIMEOUT_MS, "managed call completion");
      await withTimeout(session.run, OPERATION_TIMEOUT_MS, "managed transport run");
    } catch (error) {
      const code = errorCode(error);
      throw new SmokeDiagnosticError(
        `Managed transport run failed${code ? ` (${code})` : ""}; ` +
          `${safeErrorLocation(error)}; ` +
          `sessionReady=${sessionReady}; inputFrames=${inputFrames}; ` +
          `outputAudioFrames=${outputAudioFrames}; assistantMessages=${assistantMessages}; ` +
          `outputCommits=${outputCommits}; messages=${observedMessages.join(",") || "none"}; ` +
          `connectionEvents=${connectionEvents.join(",") || "none"}`,
      );
    }
    smokePhase = "managed_finalization";
    const finalSession = await withTimeout(
      session.finalSession,
      OPERATION_TIMEOUT_MS,
      "managed terminal session",
    );
    smokePhase = "managed_output_validation";
    if (
      finalSession.status !== "completed" ||
      finalSession.terminalSource !== "normal_completion"
    ) {
      throw new Error("managed smoke did not persist the expected normal completed result");
    }
    if (outputAudioFrames === 0 || outputCommits === 0 || assistantMessages === 0) {
      throw new Error(
        `provider smoke transport produced no complete assistant output: ` +
          `sessionReady=${sessionReady}; inputFrames=${inputFrames}; ` +
          `outputAudioFrames=${outputAudioFrames}; assistantMessages=${assistantMessages}; ` +
          `outputCommits=${outputCommits}; messages=${observedMessages.join(",") || "none"}; ` +
          `connectionEvents=${connectionEvents.join(",") || "none"}`,
      );
    }
    await shutdown();
    if (!connectionEvents.includes("session_ended:1000")) {
      throw new SmokeDiagnosticError(
        `Managed transport did not close cleanly; ` +
          `connectionEvents=${connectionEvents.join(",") || "none"}`,
      );
    }
    return {
      transport: "web-client-audio",
      sessionReady,
      inputFrames,
      outputAudioFrames,
      outputAudioBytes,
      assistantMessages,
      assistantTextCharacters,
      outputCommits,
      cleanShutdown: true,
      managedUsage: { ...managedUsage },
      finalSession: {
        sessionId: String(finalSession.id),
        ...(finalSession.callId ? { callId: String(finalSession.callId) } : {}),
        status: finalSession.status,
        ...(finalSession.terminalSource ? { terminalSource: finalSession.terminalSource } : {}),
        startedAt: finalSession.startedAt,
        endedAt: finalSession.endedAt,
      },
    };
  } finally {
    if (!shutdownComplete) {
      if (client) {
        await withTimeout(
          closeWebSocket(client),
          OPERATION_TIMEOUT_MS,
          "WebSocket client cleanup",
        ).catch(() => undefined);
      }
      await withTimeout(agent.stop(), OPERATION_TIMEOUT_MS, "voice agent cleanup").catch(
        () => undefined,
      );
      await withTimeout(plane.stop(), OPERATION_TIMEOUT_MS, "media plane cleanup").catch(
        () => undefined,
      );
    }
  }
}

function connectWebSocket(url: string): Promise<WsWebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const onOpen = (): void => {
      socket.off("error", onError);
      resolve(socket);
    };
    const onError = (error: Error): void => {
      socket.off("open", onOpen);
      reject(error);
    };
    socket.once("open", onOpen);
    socket.once("error", onError);
  });
}

function closeWebSocket(socket: WsWebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    socket.once("close", () => resolve());
    socket.close();
  });
}

function webClientAudioFrame(chunk: Uint8Array, sequence: number): Buffer {
  const frame = Buffer.alloc(12 + chunk.byteLength);
  frame.writeUInt8(1, 0);
  frame.writeUInt8(0, 1);
  frame.writeUInt32LE(sequence, 2);
  frame.writeUInt32LE((sequence - 1) * CHUNK_DURATION_MS, 6);
  frame.writeUInt16LE(0, 10);
  Buffer.from(chunk).copy(frame, 12);
  return frame;
}

function parseClientJson(data: RawData): Readonly<Record<string, unknown>> | null {
  try {
    const parsed: unknown = JSON.parse(data.toString());
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Readonly<Record<string, unknown>>)
      : null;
  } catch {
    return null;
  }
}

function errorCode(error: unknown): unknown {
  if (!isTvicError(error)) return undefined;
  return "error" in error ? error.error.code : error.code;
}

function safeErrorLocation(error: unknown): string {
  if (!(error instanceof Error)) return `errorType=${typeof error}`;
  const frames = (error.stack ?? "")
    .split("\n")
    .slice(1)
    .map((line) => line.match(/(?:\/packages\/|\/node_modules\/)([^():]+):\d+:\d+/u)?.[1])
    .filter((frame): frame is string => frame !== undefined)
    .slice(0, 4);
  return `errorType=${error.constructor.name}; stack=${frames.join(",") || "unavailable"}`;
}

function rawDataByteLength(data: RawData): number {
  return Array.isArray(data)
    ? data.reduce((total, chunk) => total + chunk.byteLength, 0)
    : data.byteLength;
}

async function waitFor(predicate: () => boolean, timeoutMs = OPERATION_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("provider smoke condition timed out");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operation: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${operation} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new MissingEnvironmentVariableError(name);
  return value;
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function writeEvidence(evidence: SmokeEvidence): void {
  const directory = fileURLToPath(new URL("../local/task-2/", import.meta.url));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(EVIDENCE_PATH, 0o600);
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
    if (!match) continue;
    const name = match[1];
    const raw = match[2] ?? "";
    if (!name || process.env[name] !== undefined) continue;
    process.env[name] = parseEnvValue(raw);
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
