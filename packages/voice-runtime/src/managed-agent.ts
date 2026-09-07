import type {
  Agent,
  AgentAudioPolicy,
  AgentContextPolicy,
  AgentMemoryPolicy,
  Call,
  CallHandle,
  ChannelKind,
  EndSessionRequest,
  HealthSnapshot,
  InterruptionPolicy,
  LLMProvider,
  OrganizationId,
  RuntimeOptions,
  SessionAttachment,
  SessionId,
  SpeechToTextProvider,
  TelephonyProvider,
  TextToSpeechProvider,
  ToolDefinition,
  WorkflowId,
  UserId,
} from "@tvic/core";
import {
  cancelledError,
  internalError,
  normalizeUnknownError,
  nowTimestamp,
  PCM16_16K_MONO,
  PROVIDER_NAMES,
  TvicThrowableError,
  validationError,
} from "@tvic/core";
import {
  createAssemblyAiSttProvider,
  createCartesiaTtsProvider,
  createDeepgramSttProvider,
  createElevenLabsSttProvider,
  createElevenLabsTtsProvider,
  createOpenAiResponsesLlmProvider,
  createSarvamSttProvider,
  createSonioxSttProvider,
  createTwilioMediaStreamsProvider,
  createWebClientAudioProvider,
  PROVIDER_CATALOG,
  type AssemblyAiSttProviderOptions,
  type CartesiaTtsProviderOptions,
  type DeepgramSttProviderOptions,
  type ElevenLabsSttProviderOptions,
  type ElevenLabsTtsProviderOptions,
  type OpenAiResponsesLlmProviderOptions,
  type SarvamSttProviderOptions,
  type SonioxSttProviderOptions,
  type TwilioMediaStreamSocket,
  type WebClientAudioProviderOptions,
} from "@tvic/providers";
import {
  createRuntime,
  defineAgent,
  PipelineVoiceLoop,
  type DualProtocolResult,
  type PipelineVoiceLoopResult,
  type PipelineVoiceLoopOptions,
  type SttReconnectOptions,
  type TextDeliveryMode,
  type VoiceEvent,
} from "@tvic/runtime";

type WithoutApiKey<T> = Omit<T, "apiKey">;

export type DeepgramProviderConfig = WithoutApiKey<DeepgramSttProviderOptions> & {
  readonly provider: "deepgram";
  readonly apiKey?: string;
  readonly model?: string;
};

export type SarvamProviderConfig = WithoutApiKey<SarvamSttProviderOptions> & {
  readonly provider: "sarvam";
  readonly apiKey?: string;
  readonly model?: string;
};

export type ElevenLabsSttProviderConfig = Omit<
  ElevenLabsSttProviderOptions,
  "apiKey" | "modelId"
> & {
  readonly provider: "elevenlabs";
  readonly apiKey?: string;
  readonly model?: string;
};

export type AssemblyAiProviderConfig = Omit<AssemblyAiSttProviderOptions, "apiKey" | "modelId"> & {
  readonly provider: "assemblyai";
  readonly apiKey?: string;
  readonly model?: string;
};

export type SonioxProviderConfig = Omit<SonioxSttProviderOptions, "apiKey" | "modelId"> & {
  readonly provider: "soniox";
  readonly apiKey?: string;
  readonly model?: string;
};

export type SttProviderConfig =
  | DeepgramProviderConfig
  | SarvamProviderConfig
  | ElevenLabsSttProviderConfig
  | AssemblyAiProviderConfig
  | SonioxProviderConfig;

export type OpenAiProviderConfig = Omit<OpenAiResponsesLlmProviderOptions, "apiKey"> & {
  readonly provider: "openai" | "openai-responses";
  readonly apiKey?: string;
  readonly model?: string;
  /** Allows a custom OpenAI-compatible endpoint to use a model outside TVIC's dated catalog. */
  readonly allowUnknownModel?: boolean;
};

export type LlmProviderConfig = OpenAiProviderConfig;

export type CartesiaProviderConfig = Omit<
  CartesiaTtsProviderOptions,
  "apiKey" | "voiceId" | "modelId"
> & {
  readonly provider: "cartesia";
  readonly apiKey?: string;
  readonly model?: string;
  readonly voiceId?: string;
};

export type ElevenLabsTtsProviderConfig = Omit<
  ElevenLabsTtsProviderOptions,
  "apiKey" | "voiceId" | "modelId"
> & {
  readonly provider: "elevenlabs";
  readonly apiKey?: string;
  readonly model?: string;
  readonly voiceId?: string;
};

export type TtsProviderConfig = CartesiaProviderConfig | ElevenLabsTtsProviderConfig;

export type TelephonyProviderConfig =
  | {
      readonly provider: "web-client-audio";
      readonly options?: WebClientAudioProviderOptions;
    }
  | { readonly provider: "twilio" };

export type VoiceAgentProviders = {
  readonly telephony: TelephonyProvider | TelephonyProviderConfig;
  readonly stt: SpeechToTextProvider | SttProviderConfig;
  readonly llm: LLMProvider | LlmProviderConfig;
  readonly tts: TextToSpeechProvider | TtsProviderConfig;
};

export interface VoiceAgentModels {
  readonly stt?: string;
  readonly llm?: string;
  readonly tts?: string;
  readonly ttsVoice?: string;
}

export interface CreateVoiceAgentOptions {
  readonly prompt: string;
  readonly id?: string;
  readonly name?: string;
  readonly version?: string;
  readonly providers: VoiceAgentProviders;
  readonly models?: VoiceAgentModels;
  /** Tool generics are intentionally erased at the heterogeneous agent boundary. */
  readonly tools?: readonly ToolDefinition<any, any>[];
  readonly audio?: Partial<AgentAudioPolicy>;
  readonly memoryPolicy?: AgentMemoryPolicy;
  readonly contextPolicy?: AgentContextPolicy;
  readonly interruptionPolicy?: InterruptionPolicy;
  readonly runtime?: RuntimeOptions;
}

export interface VoiceAgentRunOptions {
  /**
   * A handle created by a stable TVIC transport adapter or a custom adapter.
   * A factory is useful for transports whose events must be stamped with the
   * runtime-created session id; it runs after the session is created.
   */
  readonly callHandle: CallHandle | VoiceAgentCallHandleFactory;
  /** Optional complete call record. A safe inbound record is synthesized when omitted. */
  readonly call?: Call;
  readonly channel?: ChannelKind;
  readonly variables?: Readonly<Record<string, unknown>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly memoryUserId?: UserId;
  readonly organizationId?: OrganizationId;
  readonly workflowId?: WorkflowId;
  readonly signal?: AbortSignal;
  readonly safetyIdentifier?: string;
  readonly sttReconnect?: boolean | SttReconnectOptions;
  readonly sttLanguage?: string;
  readonly textDelivery?: TextDeliveryMode;
  readonly streamStallTimeoutMs?: number;
  readonly turnEndpointTimeoutMs?: number;
  readonly turnMaxDurationMs?: number;
}

export interface VoiceAgentCallHandleContext {
  readonly sessionId: SessionId;
  readonly call: Call;
  readonly channel: ChannelKind;
}

export type VoiceAgentCallHandleFactory = (
  context: VoiceAgentCallHandleContext,
) => CallHandle | PromiseLike<CallHandle>;

export interface VoiceAgentRun extends DualProtocolResult {}

export interface VoiceAgentSession {
  readonly sessionId: SessionId;
  readonly run: VoiceAgentRun;
}

export interface VoiceAgentProviderNames {
  readonly telephony: string;
  readonly stt: string;
  readonly llm: string;
  readonly tts: string;
}

export interface VoiceAgent {
  readonly id: string;
  readonly name: string;
  readonly prompt: string;
  readonly providers: VoiceAgentProviderNames;
  start(options: VoiceAgentRunOptions): Promise<VoiceAgentSession>;
  run(options: VoiceAgentRunOptions): Promise<PipelineVoiceLoopResult>;
  stop(): Promise<void>;
  healthCheck(): Promise<HealthSnapshot>;
}

interface ProviderSelection<T> {
  readonly provider: T;
  readonly model: string;
  readonly allowUnknownModel?: boolean;
  readonly language?: string;
  readonly voice?: string;
}

interface ResolvedAgent {
  readonly agent: Agent;
  readonly stt: ProviderSelection<SpeechToTextProvider>;
  readonly llm: ProviderSelection<LLMProvider>;
  readonly tts: ProviderSelection<TextToSpeechProvider>;
  readonly telephony: TelephonyProvider;
}

interface ActiveManagedRun {
  readonly controller: AbortController;
  readonly closeCall: (reason: "completed" | "cancelled" | "error") => Promise<void>;
  readonly settled: Promise<void>;
}

const MANAGED_STOP_DRAIN_TIMEOUT_MS = 5_000;

function configurationError(message: string): never {
  throw TvicThrowableError.from(validationError("voice_runtime.invalid_config", message));
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    return configurationError(`${field} must be a non-empty string`);
  }
  return value;
}

function resolveApiKey(value: unknown, envName: string, provider: string): string {
  if (value !== undefined) return nonEmpty(value, `${provider} apiKey`);
  const fromEnvironment = process.env[envName];
  if (fromEnvironment !== undefined) return nonEmpty(fromEnvironment, envName);
  return configurationError(`Missing credentials for ${provider}; pass apiKey or set ${envName}`);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : nonEmpty(value, field);
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    isRecord(value) &&
    typeof (value as { readonly [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] ===
      "function"
  );
}

function isCallHandle(value: unknown): value is CallHandle {
  if (!isRecord(value) || typeof value.callId !== "string" || value.callId.trim().length === 0) {
    return false;
  }
  return (
    isAsyncIterable(value.events) &&
    typeof value.send === "function" &&
    typeof value.clear === "function" &&
    typeof value.close === "function" &&
    (value.deliverText === undefined || typeof value.deliverText === "function") &&
    (value.confirmPlayout === undefined || typeof value.confirmPlayout === "function")
  );
}

function validateCallHandle(value: unknown): asserts value is CallHandle {
  if (!isCallHandle(value)) {
    configurationError(
      "callHandle must include a non-empty callId, async events, and send/clear/close methods",
    );
  }
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return (
    isRecord(value) &&
    typeof value.aborted === "boolean" &&
    typeof value.addEventListener === "function" &&
    typeof value.removeEventListener === "function"
  );
}

function isChannelKind(value: unknown): value is ChannelKind {
  return value === "phone" || value === "web_audio" || value === "simulated";
}

function validateRunOptions(options: VoiceAgentRunOptions): void {
  if (options.signal !== undefined && !isAbortSignal(options.signal)) {
    configurationError("signal must be an AbortSignal");
  }
  if (options.channel !== undefined && !isChannelKind(options.channel)) {
    configurationError(`channel must be phone, web_audio, or simulated`);
  }
  for (const [field, value] of [
    ["variables", options.variables],
    ["metadata", options.metadata],
  ] as const) {
    if (value !== undefined && !isRecord(value)) {
      configurationError(`${field} must be an object`);
    }
  }
  for (const [field, value] of [
    ["memoryUserId", options.memoryUserId],
    ["organizationId", options.organizationId],
    ["workflowId", options.workflowId],
    ["safetyIdentifier", options.safetyIdentifier],
    ["sttLanguage", options.sttLanguage],
  ] as const) {
    if (value !== undefined) nonEmpty(value, field);
  }
  if (
    options.textDelivery !== undefined &&
    options.textDelivery !== "auto" &&
    options.textDelivery !== "always" &&
    options.textDelivery !== "never"
  ) {
    configurationError("textDelivery must be auto, always, or never");
  }
  for (const [field, value] of [
    ["streamStallTimeoutMs", options.streamStallTimeoutMs],
    ["turnEndpointTimeoutMs", options.turnEndpointTimeoutMs],
    ["turnMaxDurationMs", options.turnMaxDurationMs],
  ] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
      configurationError(`${field} must be a positive finite number`);
    }
  }
}

function isProvider(value: unknown): value is {
  readonly kind: string;
  readonly name: string;
  readonly capabilities: unknown;
} {
  return (
    isRecord(value) &&
    typeof value.kind === "string" &&
    typeof value.name === "string" &&
    isRecord(value.capabilities)
  );
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isBooleanRecord(value: unknown, fields: readonly string[]): boolean {
  return isRecord(value) && fields.every((field) => typeof value[field] === "boolean");
}

function isAudioFormat(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.encoding === "string" &&
    typeof value.sampleRateHz === "number" &&
    typeof value.channels === "number" &&
    Number.isFinite(value.sampleRateHz) &&
    Number.isInteger(value.channels) &&
    value.sampleRateHz > 0 &&
    value.channels > 0
  );
}

function isProviderCapabilities(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !isBooleanRecord(value.streaming, ["input", "output", "native"]) ||
    !isBooleanRecord(value.cancellation, ["request", "output", "buffer", "truncation"]) ||
    !isStringArray(value.transports)
  ) {
    return false;
  }
  for (const field of [
    "languages",
    "models",
    "voices",
    "turnDetection",
    "callControl",
    "regions",
    "dataPolicies",
  ]) {
    if (value[field] !== undefined && !isStringArray(value[field])) return false;
  }
  if (value.audio !== undefined) {
    if (!isRecord(value.audio)) return false;
    for (const field of ["input", "output"]) {
      if (
        value.audio[field] !== undefined &&
        (!Array.isArray(value.audio[field]) || !value.audio[field].every(isAudioFormat))
      ) {
        return false;
      }
    }
  }
  if (
    value.tools !== undefined &&
    !isBooleanRecord(value.tools, ["functionCalling", "parallelCalls"])
  ) {
    return false;
  }
  if (
    value.playout !== undefined &&
    !isBooleanRecord(value.playout, ["clearBuffer", "acknowledgement", "position"])
  ) {
    return false;
  }
  return true;
}

function assertProviderKind(value: unknown, expected: string): void {
  if (!isProvider(value) || value.kind !== expected) {
    configurationError(`Expected a ${expected} provider instance`);
  }
  if (!isProviderCapabilities(value.capabilities)) {
    configurationError(`${expected} provider capabilities are malformed`);
  }
  const requiredMethods: Readonly<Record<string, readonly string[]>> = {
    telephony: ["dial", "accept", "hangup"],
    stt: ["open"],
    llm: ["complete"],
    tts: ["synthesize"],
  };
  for (const method of requiredMethods[expected] ?? []) {
    if (typeof (value as Record<string, unknown>)[method] !== "function") {
      configurationError(`${expected} provider must implement ${method}()`);
    }
  }
}

function selectedModel(
  override: string | undefined,
  configured: string | undefined,
  fallback: string | undefined,
  field: string,
): string {
  return nonEmpty(override ?? configured ?? fallback ?? "default", field);
}

function validateSelectedModel(
  provider: {
    readonly name: string;
    readonly capabilities: { readonly models?: readonly string[] };
  },
  model: string,
  field: string,
  allowUnknown = false,
): void {
  const supportedModels = provider.capabilities.models;
  if (
    allowUnknown ||
    supportedModels === undefined ||
    supportedModels.length === 0 ||
    supportedModels.includes(model)
  ) {
    return;
  }
  configurationError(
    `${provider.name} does not support model ${model} for ${field}; supported models: ${supportedModels.join(", ")}`,
  );
}

function validateSelectedVoice(
  provider: {
    readonly name: string;
    readonly capabilities: { readonly voices?: readonly string[] };
  },
  voice: string | undefined,
  field: string,
): void {
  const supportedVoices = provider.capabilities.voices;
  if (
    voice === undefined ||
    supportedVoices === undefined ||
    supportedVoices.length === 0 ||
    supportedVoices.includes(voice)
  ) {
    return;
  }
  configurationError(
    `${provider.name} does not support voice ${voice} for ${field}; supported voices: ${supportedVoices.join(", ")}`,
  );
}

function resolveTelephony(spec: TelephonyProvider | TelephonyProviderConfig): TelephonyProvider {
  if (isProvider(spec)) {
    assertProviderKind(spec, "telephony");
    return spec as TelephonyProvider;
  }
  if (!isRecord(spec) || typeof spec.provider !== "string") {
    return configurationError("providers.telephony must be a provider instance or configuration");
  }
  switch (spec.provider) {
    case "web-client-audio": {
      const options = spec.options;
      if (options !== undefined && !isRecord(options)) {
        return configurationError("providers.telephony.options must be an object");
      }
      return createWebClientAudioProvider(options as WebClientAudioProviderOptions | undefined);
    }
    case "twilio":
      return createTwilioMediaStreamsProvider();
    default:
      return configurationError("Unknown telephony provider");
  }
}

function resolveStt(
  spec: SpeechToTextProvider | SttProviderConfig,
  overrideModel: string | undefined,
): ProviderSelection<SpeechToTextProvider> {
  if (isProvider(spec)) {
    assertProviderKind(spec, "stt");
    const provider = spec as SpeechToTextProvider;
    return {
      provider,
      model: selectedModel(
        overrideModel,
        undefined,
        provider.capabilities.models?.[0],
        "models.stt",
      ),
    };
  }
  if (!isRecord(spec) || typeof spec.provider !== "string") {
    return configurationError("providers.stt must be a provider instance or configuration");
  }
  const configuredModel = optionalString(spec.model, "models.stt");
  const model = selectedModel(overrideModel, configuredModel, undefined, "models.stt");
  switch (spec.provider) {
    case "deepgram": {
      const {
        provider: _provider,
        apiKey: _apiKey,
        model: _model,
        ...options
      } = spec as DeepgramProviderConfig;
      return {
        provider: createDeepgramSttProvider({
          ...options,
          apiKey: resolveApiKey(_apiKey, "DEEPGRAM_API_KEY", "deepgram"),
        }),
        model: model === "default" ? PROVIDER_CATALOG.deepgram.defaultModel : model,
        ...(options.allowUnknownModel ? { allowUnknownModel: true } : {}),
      };
    }
    case "sarvam": {
      const {
        provider: _provider,
        apiKey: _apiKey,
        model: _model,
        ...options
      } = spec as SarvamProviderConfig;
      return {
        provider: createSarvamSttProvider({
          ...options,
          apiKey: resolveApiKey(_apiKey, "SARVAM_API_KEY", "sarvam"),
        }),
        model: model === "default" ? PROVIDER_CATALOG.sarvam.defaultModel : model,
        ...(options.allowUnknownModel ? { allowUnknownModel: true } : {}),
      };
    }
    case "elevenlabs": {
      const {
        provider: _provider,
        apiKey: _apiKey,
        model: _model,
        ...options
      } = spec as ElevenLabsSttProviderConfig;
      return {
        provider: createElevenLabsSttProvider({
          ...options,
          apiKey: resolveApiKey(_apiKey, "ELEVENLABS_API_KEY", "elevenlabs STT"),
          ...(model !== "default" ? { modelId: model } : {}),
        }),
        model: model === "default" ? PROVIDER_CATALOG.elevenlabsStt.defaultModel : model,
        ...(options.allowUnknownModel ? { allowUnknownModel: true } : {}),
      };
    }
    case "assemblyai": {
      const {
        provider: _provider,
        apiKey: _apiKey,
        model: _model,
        ...options
      } = spec as AssemblyAiProviderConfig;
      return {
        provider: createAssemblyAiSttProvider({
          ...options,
          apiKey: resolveApiKey(_apiKey, "ASSEMBLYAI_API_KEY", "assemblyai"),
          ...(model !== "default" ? { modelId: model } : {}),
        }),
        model: model === "default" ? PROVIDER_CATALOG.assemblyai.defaultModel : model,
        ...(options.allowUnknownModel ? { allowUnknownModel: true } : {}),
      };
    }
    case "soniox": {
      const {
        provider: _provider,
        apiKey: _apiKey,
        model: _model,
        ...options
      } = spec as SonioxProviderConfig;
      return {
        provider: createSonioxSttProvider({
          ...options,
          apiKey: resolveApiKey(_apiKey, "SONIOX_API_KEY", "soniox"),
          ...(model !== "default" ? { modelId: model } : {}),
        }),
        model: model === "default" ? PROVIDER_CATALOG.soniox.defaultModel : model,
        ...(options.allowUnknownModel ? { allowUnknownModel: true } : {}),
      };
    }
    default:
      return configurationError("Unknown STT provider");
  }
}

function resolveLlm(
  spec: LLMProvider | LlmProviderConfig,
  overrideModel: string | undefined,
): ProviderSelection<LLMProvider> {
  if (isProvider(spec)) {
    assertProviderKind(spec, "llm");
    const provider = spec as LLMProvider;
    return {
      provider,
      model: selectedModel(
        overrideModel,
        undefined,
        provider.capabilities.models?.[0],
        "models.llm",
      ),
    };
  }
  if (!isRecord(spec) || typeof spec.provider !== "string") {
    return configurationError("providers.llm must be a provider instance or configuration");
  }
  if (spec.provider !== "openai" && spec.provider !== "openai-responses") {
    return configurationError(`Unknown LLM provider: ${spec.provider}`);
  }
  const configuredModel = optionalString(spec.model, "models.llm");
  const {
    provider: _provider,
    apiKey: _apiKey,
    model: _model,
    allowUnknownModel: _allowUnknownModel,
    ...options
  } = spec as OpenAiProviderConfig;
  return {
    provider: createOpenAiResponsesLlmProvider({
      ...options,
      apiKey: resolveApiKey(_apiKey, "OPENAI_API_KEY", "openai"),
    }),
    model: selectedModel(
      overrideModel,
      configuredModel,
      PROVIDER_CATALOG.openaiResponses.defaultModel,
      "models.llm",
    ),
    ...(spec.allowUnknownModel ? { allowUnknownModel: true } : {}),
  };
}

function resolveTts(
  spec: TextToSpeechProvider | TtsProviderConfig,
  overrideModel: string | undefined,
  overrideVoice: string | undefined,
): ProviderSelection<TextToSpeechProvider> {
  if (isProvider(spec)) {
    assertProviderKind(spec, "tts");
    const provider = spec as TextToSpeechProvider;
    const voice =
      overrideVoice !== undefined
        ? nonEmpty(overrideVoice, "models.ttsVoice")
        : provider.capabilities.voices?.[0];
    return {
      provider,
      model: selectedModel(
        overrideModel,
        undefined,
        provider.capabilities.models?.[0],
        "models.tts",
      ),
      ...(voice !== undefined ? { voice } : {}),
    };
  }
  if (!isRecord(spec) || typeof spec.provider !== "string") {
    return configurationError("providers.tts must be a provider instance or configuration");
  }
  const configuredModel = optionalString(spec.model, "models.tts");
  const model = selectedModel(overrideModel, configuredModel, undefined, "models.tts");
  switch (spec.provider) {
    case "cartesia": {
      const config = spec as CartesiaProviderConfig;
      const voiceId = nonEmpty(
        overrideVoice ?? config.voiceId ?? process.env.CARTESIA_VOICE_ID,
        "models.ttsVoice or CARTESIA_VOICE_ID",
      );
      const {
        provider: _provider,
        apiKey: _apiKey,
        model: _model,
        voiceId: _voiceId,
        ...options
      } = config;
      return {
        provider: createCartesiaTtsProvider({
          ...options,
          apiKey: resolveApiKey(_apiKey, "CARTESIA_API_KEY", "cartesia"),
          voiceId,
          ...(model !== "default" ? { modelId: model } : {}),
        }),
        model: model === "default" ? PROVIDER_CATALOG.cartesia.defaultModel : model,
        voice: voiceId,
      };
    }
    case "elevenlabs": {
      const config = spec as ElevenLabsTtsProviderConfig;
      const voiceId = nonEmpty(
        overrideVoice ?? config.voiceId ?? process.env.ELEVENLABS_VOICE_ID,
        "models.ttsVoice or ELEVENLABS_VOICE_ID",
      );
      const {
        provider: _provider,
        apiKey: _apiKey,
        model: _model,
        voiceId: _voiceId,
        ...options
      } = config;
      return {
        provider: createElevenLabsTtsProvider({
          ...options,
          apiKey: resolveApiKey(_apiKey, "ELEVENLABS_API_KEY", "elevenlabs TTS"),
          voiceId,
          ...(model !== "default" ? { modelId: model } : {}),
        }),
        model: model === "default" ? PROVIDER_CATALOG.elevenlabs.defaultModel : model,
        voice: voiceId,
      };
    }
    default:
      return configurationError("Unknown TTS provider");
  }
}

function resolveAgent(options: CreateVoiceAgentOptions): ResolvedAgent {
  if (!isRecord(options)) {
    return configurationError("createVoiceAgent options must be an object");
  }
  const prompt = nonEmpty(options.prompt, "prompt");
  if (!isRecord(options.providers)) {
    return configurationError("providers must be an object");
  }
  if (options.models !== undefined && !isRecord(options.models)) {
    return configurationError("models must be an object");
  }
  if (options.tools !== undefined && !Array.isArray(options.tools)) {
    return configurationError("tools must be an array");
  }
  const providers = options.providers;
  const telephony = resolveTelephony(providers.telephony);
  const stt = resolveStt(providers.stt, optionalString(options.models?.stt, "models.stt"));
  const llm = resolveLlm(providers.llm, optionalString(options.models?.llm, "models.llm"));
  const tts = resolveTts(
    providers.tts,
    optionalString(options.models?.tts, "models.tts"),
    optionalString(options.models?.ttsVoice, "models.ttsVoice"),
  );
  validateSelectedModel(stt.provider, stt.model, "models.stt", stt.allowUnknownModel);
  validateSelectedModel(llm.provider, llm.model, "models.llm", llm.allowUnknownModel);
  validateSelectedModel(tts.provider, tts.model, "models.tts");
  validateSelectedVoice(tts.provider, tts.voice, "models.ttsVoice");
  const audioPolicy: AgentAudioPolicy = {
    input: options.audio?.input ?? PCM16_16K_MONO,
    output: options.audio?.output ?? PCM16_16K_MONO,
  };
  const agent = defineAgent({
    id: options.id ?? "voice-agent",
    name: options.name ?? "Voice Agent",
    version: options.version ?? "1.0.0",
    instructions: prompt,
    tools: options.tools ?? [],
    providers: { telephony, stt: stt.provider, llm: llm.provider, tts: tts.provider },
    audioPolicy,
    ...(options.memoryPolicy ? { memoryPolicy: options.memoryPolicy } : {}),
    ...(options.contextPolicy ? { contextPolicy: options.contextPolicy } : {}),
    ...(options.interruptionPolicy ? { interruptionPolicy: options.interruptionPolicy } : {}),
  });
  return { agent, stt, llm, tts, telephony };
}

function defaultChannel(provider: TelephonyProvider): ChannelKind {
  if (provider.name === PROVIDER_NAMES.twilio) return "phone";
  if (provider.name === PROVIDER_NAMES.webClientAudio) return "web_audio";
  return "simulated";
}

function defaultCall(
  provider: TelephonyProvider,
  callHandle: CallHandle,
  audio: AgentAudioPolicy,
): Call {
  const now = nowTimestamp();
  return {
    id: callHandle.callId,
    provider: provider.name,
    direction: "inbound",
    from: "unknown",
    to: "voice-agent",
    status: "connected",
    mediaTransport: { kind: "websocket", format: audio.input },
    createdAt: now,
    startedAt: now,
  };
}

function validateCall(call: unknown): asserts call is Call {
  if (!isRecord(call) || typeof call.id !== "string" || call.id.trim().length === 0) {
    configurationError("call must include a non-empty id");
  }
}

function validateCallHandleMatchesCall(call: Call, callHandle: CallHandle): void {
  if (call.id !== callHandle.callId) {
    configurationError(`call.id must match callHandle.callId (${callHandle.callId})`);
  }
}

class ManagedVoiceAgentRun implements VoiceAgentRun {
  readonly #raw: DualProtocolResult;
  readonly #completion: Promise<PipelineVoiceLoopResult>;

  constructor(
    raw: DualProtocolResult,
    finalize: (outcome: {
      readonly result?: PipelineVoiceLoopResult;
      readonly error?: unknown;
    }) => Promise<void>,
  ) {
    this.#raw = raw;
    this.#completion = Promise.resolve(raw).then(
      async (result) => {
        await finalize({ result });
        return result;
      },
      async (error: unknown) => {
        await finalize({ error });
        throw error;
      },
    );
  }

  get sessionId(): SessionId {
    return this.#raw.sessionId;
  }

  then<TResult1 = PipelineVoiceLoopResult, TResult2 = never>(
    onfulfilled?:
      | ((value: PipelineVoiceLoopResult) => TResult1 | PromiseLike<TResult1>)
      | null
      | undefined,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null | undefined,
  ): PromiseLike<TResult1 | TResult2> {
    return this.#completion.then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null | undefined,
  ): PromiseLike<PipelineVoiceLoopResult | TResult> {
    return this.#completion.catch(onrejected);
  }

  finally(onfinally?: (() => void) | null | undefined): PromiseLike<PipelineVoiceLoopResult> {
    return this.#completion.finally(onfinally);
  }

  [Symbol.asyncIterator](): AsyncIterator<VoiceEvent> {
    return this.#raw[Symbol.asyncIterator]();
  }
}

class ManagedVoiceAgent implements VoiceAgent {
  readonly id: string;
  readonly name: string;
  readonly prompt: string;
  readonly providers: VoiceAgentProviderNames;
  readonly #resolved: ResolvedAgent;
  readonly #runtime: ReturnType<typeof createRuntime>;
  readonly #activeRuns = new Map<SessionId, ActiveManagedRun>();
  #stopPromise: Promise<void> | undefined;

  constructor(options: CreateVoiceAgentOptions) {
    this.#resolved = resolveAgent(options);
    this.id = this.#resolved.agent.id;
    this.name = this.#resolved.agent.name;
    this.prompt = this.#resolved.agent.instructions;
    this.providers = Object.freeze({
      telephony: this.#resolved.telephony.name,
      stt: this.#resolved.stt.provider.name,
      llm: this.#resolved.llm.provider.name,
      tts: this.#resolved.tts.provider.name,
    });
    this.#runtime = createRuntime(options.runtime ?? {});
  }

  async start(options: VoiceAgentRunOptions): Promise<VoiceAgentSession> {
    if (this.#stopPromise) {
      return configurationError("Voice agent has been stopped");
    }
    if (!isRecord(options)) {
      return configurationError("agent.start options must be an object");
    }
    validateRunOptions(options);
    if (options.signal?.aborted) {
      throw TvicThrowableError.from(
        cancelledError("voice_runtime.start_cancelled", "Voice agent startup was cancelled"),
      );
    }
    let callHandleFactory: VoiceAgentCallHandleFactory | undefined;
    let preconstructedCallHandle: CallHandle | undefined;
    if (typeof options.callHandle === "function") {
      callHandleFactory = options.callHandle;
    } else {
      preconstructedCallHandle = options.callHandle;
      validateCallHandle(preconstructedCallHandle);
    }
    if (callHandleFactory && options.call === undefined) {
      return configurationError("call is required when callHandle is a factory");
    }
    if (options.call) validateCall(options.call);
    let activeCallHandle: CallHandle | undefined;
    let closePromise: Promise<void> | undefined;
    const closeCall = (reason: "completed" | "cancelled" | "error"): Promise<void> => {
      if (!closePromise && activeCallHandle) {
        closePromise = Promise.resolve().then(() => activeCallHandle!.close(reason));
      }
      return closePromise ?? Promise.resolve();
    };
    await this.#runtime.start();
    let attachment: SessionAttachment | undefined;
    try {
      let provisionalCall: Call;
      if (options.call) {
        provisionalCall = options.call;
      } else {
        if (!preconstructedCallHandle) {
          return configurationError("call is required when callHandle is a factory");
        }
        provisionalCall = defaultCall(
          this.#resolved.telephony,
          preconstructedCallHandle,
          this.#resolved.agent.audioPolicy,
        );
      }
      const channel = options.channel ?? defaultChannel(this.#resolved.telephony);
      attachment = await this.#runtime.startAttachedSession(this.#resolved.agent, {
        channel,
        call: provisionalCall,
        ...(options.variables ? { variables: options.variables } : {}),
        ...(options.metadata ? { metadata: options.metadata } : {}),
        ...(options.memoryUserId ? { memoryUserId: options.memoryUserId } : {}),
        ...(options.organizationId ? { organizationId: options.organizationId } : {}),
        ...(options.workflowId ? { workflowId: options.workflowId } : {}),
      });

      if (callHandleFactory) {
        activeCallHandle = await callHandleFactory({
          sessionId: attachment.session.id,
          call: provisionalCall,
          channel,
        });
      } else {
        if (!preconstructedCallHandle) {
          return configurationError("callHandle must be a handle or factory");
        }
        activeCallHandle = preconstructedCallHandle;
      }
      validateCallHandle(activeCallHandle);
      validateCallHandleMatchesCall(provisionalCall, activeCallHandle);

      const loopOptions = {
        runtime: this.#runtime,
        session: attachment.session,
        attachment,
        agent: this.#resolved.agent,
        callHandle: activeCallHandle,
        llmModel: this.#resolved.llm.model,
        sttModel: this.#resolved.stt.model,
        ttsModel: this.#resolved.tts.model,
        ...(this.#resolved.stt.allowUnknownModel ? { sttAllowUnknownModel: true } : {}),
        ...(this.#resolved.tts.voice !== undefined ? { ttsVoice: this.#resolved.tts.voice } : {}),
        ...(options.sttReconnect !== undefined ? { sttReconnect: options.sttReconnect } : {}),
        ...(options.sttLanguage !== undefined ? { sttLanguage: options.sttLanguage } : {}),
        ...(options.safetyIdentifier !== undefined
          ? { safetyIdentifier: options.safetyIdentifier }
          : {}),
        ...(options.textDelivery !== undefined ? { textDelivery: options.textDelivery } : {}),
        ...(options.streamStallTimeoutMs !== undefined
          ? { streamStallTimeoutMs: options.streamStallTimeoutMs }
          : {}),
        ...(options.turnEndpointTimeoutMs !== undefined
          ? { turnEndpointTimeoutMs: options.turnEndpointTimeoutMs }
          : {}),
        ...(options.turnMaxDurationMs !== undefined
          ? { turnMaxDurationMs: options.turnMaxDurationMs }
          : {}),
      } satisfies PipelineVoiceLoopOptions;

      const loop = new PipelineVoiceLoop(loopOptions);
      const stopController = new AbortController();
      const runSignal = options.signal
        ? AbortSignal.any([options.signal, stopController.signal])
        : stopController.signal;
      const raw = loop._startInternal({ overrideSignal: runSignal });
      const activeAttachment = attachment;
      const run = new ManagedVoiceAgentRun(raw, (outcome) =>
        this.#finalizeRun(activeAttachment, closeCall, runSignal, outcome),
      );
      const activeRun: ActiveManagedRun = {
        controller: stopController,
        closeCall,
        settled: Promise.resolve(run).then(
          () => {
            this.#activeRuns.delete(activeAttachment.session.id);
          },
          () => {
            this.#activeRuns.delete(activeAttachment.session.id);
          },
        ),
      };
      this.#activeRuns.set(activeAttachment.session.id, activeRun);
      return { sessionId: activeAttachment.session.id, run };
    } catch (error) {
      if (attachment) {
        await this.#finalizeRun(attachment, closeCall, options.signal, { error }).catch(
          () => undefined,
        );
      }
      throw error;
    }
  }

  async run(options: VoiceAgentRunOptions): Promise<PipelineVoiceLoopResult> {
    const session = await this.start(options);
    return await session.run;
  }

  stop(): Promise<void> {
    if (!this.#stopPromise) this.#stopPromise = this.#stopInternal();
    return this.#stopPromise;
  }

  healthCheck(): Promise<HealthSnapshot> {
    return this.#runtime.healthCheck();
  }

  async #stopInternal(): Promise<void> {
    const activeRuns = [...this.#activeRuns.values()];
    const drain = Promise.allSettled(
      activeRuns.map(async ({ controller, closeCall, settled }) => {
        controller.abort();
        await closeCall("cancelled").catch(() => undefined);
        await settled;
      }),
    );
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        drain,
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, MANAGED_STOP_DRAIN_TIMEOUT_MS);
          timeout.unref?.();
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    await this.#runtime.stop();
  }

  async #finalizeRun(
    attachment: SessionAttachment,
    closeCall: (reason: "completed" | "cancelled" | "error") => Promise<void>,
    signal: AbortSignal | undefined,
    outcome: { readonly result?: PipelineVoiceLoopResult; readonly error?: unknown },
  ): Promise<void> {
    let request: EndSessionRequest;
    let closeReason: "completed" | "cancelled" | "error" = "completed";
    if (outcome.result) {
      if (outcome.result.turnsFailed > 0) {
        const error =
          outcome.result.firstTurnError ??
          internalError("voice_runtime.turn_failed", "One or more voice turns failed");
        request = { reason: "failed", error };
        closeReason = "error";
      } else {
        request = { reason: "completed" };
      }
    } else {
      const normalized = normalizeUnknownError(outcome.error, {
        code: "voice_runtime.run_failed",
        category: "internal",
        retriable: false,
      });
      if (signal?.aborted || normalized.category === "cancelled") {
        request = { reason: "cancelled", cancelReason: "operator_requested" };
        closeReason = "cancelled";
      } else {
        request = { reason: "failed", error: normalized };
        closeReason = "error";
      }
    }

    let firstError: unknown;
    try {
      await closeCall(closeReason);
    } catch (error) {
      firstError = error;
    }
    try {
      await this.#runtime.endSession(attachment.session.id, request);
    } catch (error) {
      firstError ??= error;
    }
    if (firstError && !outcome.error) throw firstError;
  }
}

export function createVoiceAgent(options: CreateVoiceAgentOptions): VoiceAgent {
  return new ManagedVoiceAgent(options);
}

export type { TwilioMediaStreamSocket };
