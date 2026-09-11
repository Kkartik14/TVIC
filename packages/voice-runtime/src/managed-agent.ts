import type {
  Agent,
  AgentAudioPolicy,
  AgentContextPolicy,
  AgentMemoryPolicy,
  Call,
  CallSnapshot,
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
  timeoutError,
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
  VoiceRuntimeFinalizationError,
  type CleanupErrorSummary,
  type CleanupStage,
  type DualProtocolResult,
  type PipelineVoiceLoopResult,
  type PipelineVoiceLoopOptions,
  type SttReconnectOptions,
  type TextDeliveryMode,
  type VoiceEvent,
} from "@tvic/runtime";
import { buildCallSnapshot } from "./call-snapshot.js";

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
  /** Maximum time allowed to start the runtime, attach the call, and create the run. */
  readonly startupTimeoutMs?: number;
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
  /** A deeply frozen copy of the validated call supplied to start(). */
  readonly call: CallSnapshot;
  readonly channel: ChannelKind;
  /** Aborts when the caller, startup deadline, or global agent shutdown wins. */
  readonly signal: AbortSignal;
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

const MANAGED_STOP_DRAIN_TIMEOUT_MS = 5_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;

type ManagedStartState =
  | "created"
  | "starting"
  | "attached"
  | "deferred"
  | "claimed_internal"
  | "claimed_public"
  | "running"
  | "finalizing"
  | "stopped_unclaimed"
  | "settled";

interface DeferredValue<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

function deferredValue<T>(): DeferredValue<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function nativePromiseFromThenable<T>(value: PromiseLike<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    try {
      value.then(resolve, reject);
    } catch (error) {
      reject(error);
    }
  });
}

function combinedSignal(signals: readonly AbortSignal[]): AbortSignal {
  const active = signals.filter((signal) => signal !== undefined);
  if (active.length === 1) return active[0]!;
  return AbortSignal.any(active);
}

function timeoutPromise(milliseconds: number): Promise<"timeout"> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), milliseconds);
    timer.unref?.();
  });
}

function protocolError(): TvicThrowableError {
  return TvicThrowableError.from(
    validationError(
      "voice_runtime.events_already_consumed",
      "The voice event stream has already been claimed by another consumer",
    ),
  );
}

function startupCancelledError(): TvicThrowableError {
  return TvicThrowableError.from(
    cancelledError("voice_runtime.start_cancelled", "Voice agent startup was cancelled"),
  );
}

function startupTimeoutError(milliseconds: number): TvicThrowableError {
  return TvicThrowableError.from(
    normalizeUnknownError(
      timeoutError(
        "voice_runtime.start_timeout",
        `Voice agent startup exceeded its ${milliseconds}ms deadline`,
      ),
      {
        code: "voice_runtime.start_timeout",
        category: "timeout",
        retriable: false,
      },
    ),
  );
}

interface ManagedRunClaim {
  readonly completion: Promise<PipelineVoiceLoopResult>;
  readonly iterator?: AsyncIterator<VoiceEvent>;
}

class ManagedVoiceEventIterator implements AsyncIterator<VoiceEvent>, AsyncIterable<VoiceEvent> {
  #done = false;
  readonly #raw: AsyncIterator<VoiceEvent>;
  readonly #completion: Promise<PipelineVoiceLoopResult>;
  readonly #cancel: () => void;

  constructor(
    raw: AsyncIterator<VoiceEvent>,
    completion: Promise<PipelineVoiceLoopResult>,
    cancel: () => void,
  ) {
    this.#raw = raw;
    this.#completion = completion;
    this.#cancel = cancel;
  }

  async next(...args: [] | [undefined]): Promise<IteratorResult<VoiceEvent>> {
    if (this.#done) return { done: true, value: undefined };
    const step = await this.#raw.next(...args);
    if (!step.done) return step;
    this.#done = true;
    await this.#completion;
    return { done: true, value: undefined };
  }

  async return(value?: unknown): Promise<IteratorResult<VoiceEvent>> {
    if (this.#done) return { done: true, value };
    this.#done = true;
    this.#cancel();
    try {
      await this.#raw.return?.(value);
    } finally {
      await this.#completion.catch(() => undefined);
    }
    return { done: true, value };
  }

  async throw(error?: unknown): Promise<IteratorResult<VoiceEvent>> {
    if (this.#done) throw error;
    this.#done = true;
    try {
      await this.#raw.throw?.(error);
    } finally {
      await this.#completion.catch(() => undefined);
    }
    throw error;
  }

  [Symbol.asyncIterator](): AsyncIterator<VoiceEvent> {
    return this;
  }
}

class RejectedVoiceEventIterator implements AsyncIterator<VoiceEvent>, AsyncIterable<VoiceEvent> {
  readonly #error: unknown;

  constructor(error: unknown) {
    this.#error = error;
  }

  next(): Promise<IteratorResult<VoiceEvent>> {
    return Promise.reject(this.#error);
  }

  return(): Promise<IteratorResult<VoiceEvent>> {
    return Promise.reject(this.#error);
  }

  [Symbol.asyncIterator](): AsyncIterator<VoiceEvent> {
    return this;
  }
}

interface ManagedRunController {
  claim(kind: "internal" | "public"): ManagedRunClaim;
  cancel(): void;
}

class ManagedVoiceAgentRun implements VoiceAgentRun {
  readonly #sessionId: SessionId;
  readonly #controller: ManagedRunController;

  constructor(sessionId: SessionId, controller: ManagedRunController) {
    this.#sessionId = sessionId;
    this.#controller = controller;
  }

  get sessionId(): SessionId {
    return this.#sessionId;
  }

  then<TResult1 = PipelineVoiceLoopResult, TResult2 = never>(
    onfulfilled?:
      | ((value: PipelineVoiceLoopResult) => TResult1 | PromiseLike<TResult1>)
      | null
      | undefined,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null | undefined,
  ): PromiseLike<TResult1 | TResult2> {
    try {
      return this.#controller.claim("internal").completion.then(onfulfilled, onrejected);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null | undefined,
  ): PromiseLike<PipelineVoiceLoopResult | TResult> {
    try {
      return this.#controller.claim("internal").completion.catch(onrejected);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  finally(onfinally?: (() => void) | null | undefined): PromiseLike<PipelineVoiceLoopResult> {
    try {
      return this.#controller.claim("internal").completion.finally(onfinally);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<VoiceEvent> {
    const claim = this.#controller.claim("public");
    if (!claim.iterator) return new RejectedVoiceEventIterator(claim.completion);
    return new ManagedVoiceEventIterator(claim.iterator, claim.completion, () =>
      this.#controller.cancel(),
    );
  }
}

interface ManagedStartRecord {
  readonly key: symbol;
  readonly options: VoiceAgentRunOptions;
  readonly startupController: AbortController;
  readonly runController: AbortController;
  readonly factorySignal: AbortSignal;
  readonly runSignal: AbortSignal;
  readonly cleanup: DeferredValue<void>;
  readonly startupTimeoutMs: number;
  state: ManagedStartState;
  timeoutExpired: boolean;
  cancelSource: "caller_abort" | "operator_stop" | undefined;
  startupTimer: ReturnType<typeof setTimeout> | undefined;
  removeCallerAbort: (() => void) | undefined;
  removeGenerationAbort: (() => void) | undefined;
  attachment: SessionAttachment | undefined;
  callHandle: CallHandle | undefined;
  handleAccepted: boolean;
  closePromise: Promise<void> | undefined;
  run: ManagedVoiceAgentRun | undefined;
  raw: DualProtocolResult | undefined;
  rawIteratorClaimed: boolean;
  claimKind: "internal" | "public" | undefined;
  completion: Promise<PipelineVoiceLoopResult> | undefined;
  finalization: Promise<void> | undefined;
  cleanupBarrier: Promise<void> | undefined;
  startupError: TvicThrowableError | undefined;
  lateCleanupPending: number;
  cleanupErrors: ReturnType<typeof cleanupErrorSummary>[];
  cleanupReadyRequested: boolean;
}

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
  return isRecord(value) && typeof dataProperty(value, Symbol.asyncIterator) === "function";
}

function dataProperty(value: object, property: PropertyKey): unknown {
  const seen = new Set<object>();
  let current: object | null = value;
  try {
    while (current !== null && !seen.has(current)) {
      seen.add(current);
      const descriptor = Object.getOwnPropertyDescriptor(current, property);
      if (descriptor) return "value" in descriptor ? descriptor.value : undefined;
      current = Object.getPrototypeOf(current);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function isCallHandle(value: unknown): value is CallHandle {
  if (!isRecord(value)) {
    return false;
  }
  const callId = dataProperty(value, "callId");
  if (typeof callId !== "string" || callId.trim().length === 0) return false;
  const events = dataProperty(value, "events");
  return (
    isAsyncIterable(events) &&
    typeof dataProperty(value, "send") === "function" &&
    typeof dataProperty(value, "clear") === "function" &&
    typeof dataProperty(value, "close") === "function" &&
    (dataProperty(value, "deliverText") === undefined ||
      typeof dataProperty(value, "deliverText") === "function") &&
    (dataProperty(value, "confirmPlayout") === undefined ||
      typeof dataProperty(value, "confirmPlayout") === "function")
  );
}

function validateCallHandle(value: unknown): asserts value is CallHandle {
  if (!isCallHandle(value)) {
    configurationError(
      "callHandle must include a non-empty callId, async events, and send/clear/close methods",
    );
  }
}

function cleanupErrorSummary(stage: CleanupStage, error: unknown): CleanupErrorSummary {
  const normalized = TvicThrowableError.from(error).error;
  return {
    stage,
    code: normalized.code.slice(0, 128),
    message: normalized.message.slice(0, 4096),
  };
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
    ["startupTimeoutMs", options.startupTimeoutMs],
  ] as const) {
    if (
      value !== undefined &&
      field !== "startupTimeoutMs" &&
      (!Number.isFinite(value) || value <= 0)
    ) {
      configurationError(`${field} must be a positive finite number`);
    }
    if (
      value !== undefined &&
      field === "startupTimeoutMs" &&
      (!Number.isSafeInteger(value) || value <= 0)
    ) {
      configurationError("startupTimeoutMs must be a positive safe integer");
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

function validateCallHandleMatchesCall(call: Call, callHandle: CallHandle): void {
  const callId = dataProperty(callHandle, "callId");
  if (call.id !== callId) {
    configurationError(`call.id must match callHandle.callId (${String(callId)})`);
  }
}

class ManagedVoiceAgent implements VoiceAgent {
  readonly id: string;
  readonly name: string;
  readonly prompt: string;
  readonly providers: VoiceAgentProviderNames;
  readonly #resolved: ResolvedAgent;
  readonly #runtime: ReturnType<typeof createRuntime>;
  readonly #records = new Set<ManagedStartRecord>();
  readonly #generationController = new AbortController();
  readonly #cleanupErrors: ReturnType<typeof cleanupErrorSummary>[] = [];
  #runtimeStartPromise: Promise<void> | undefined;
  #runtimeStartState: "idle" | "starting" | "fulfilled" | "rejected" = "idle";
  #runtimeStartInvoked = false;
  #runtimeStarted = false;
  #lifecycle: "accepting" | "stopping" | "stopped" = "accepting";
  #stopPromise: Promise<void> | undefined;
  #stopDegraded = false;
  #stopLateCleanupPending = false;

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
    if (this.#lifecycle !== "accepting") {
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
    const callSnapshot = options.call === undefined ? undefined : buildCallSnapshot(options.call);
    const recordOptions: VoiceAgentRunOptions =
      callSnapshot === undefined ? options : { ...options, call: callSnapshot };
    const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    const startupController = new AbortController();
    const runController = new AbortController();
    const cleanup = deferredValue<void>();
    const record: ManagedStartRecord = {
      key: Symbol("voice-runtime-start"),
      options: recordOptions,
      startupController,
      runController,
      factorySignal: combinedSignal([
        startupController.signal,
        ...(options.signal ? [options.signal] : []),
        this.#generationController.signal,
      ]),
      runSignal: combinedSignal([
        runController.signal,
        ...(options.signal ? [options.signal] : []),
        this.#generationController.signal,
      ]),
      cleanup,
      startupTimeoutMs,
      state: "created",
      timeoutExpired: false,
      cancelSource: undefined,
      startupTimer: undefined,
      removeCallerAbort: undefined,
      removeGenerationAbort: undefined,
      attachment: undefined,
      callHandle: preconstructedCallHandle,
      handleAccepted: preconstructedCallHandle !== undefined,
      closePromise: undefined,
      run: undefined,
      raw: undefined,
      rawIteratorClaimed: false,
      claimKind: undefined,
      completion: undefined,
      finalization: undefined,
      cleanupBarrier: undefined,
      startupError: undefined,
      lateCleanupPending: 0,
      cleanupErrors: [],
      cleanupReadyRequested: false,
    };
    this.#records.add(record);
    record.startupTimer = setTimeout(() => {
      record.timeoutExpired = true;
      startupController.abort(startupTimeoutError(startupTimeoutMs));
    }, startupTimeoutMs);
    record.startupTimer.unref?.();
    const callerAborted = () => {
      record.cancelSource = "caller_abort";
      const reason = startupCancelledError();
      startupController.abort(reason);
      runController.abort(reason);
    };
    const generationAborted = () => {
      record.cancelSource = "operator_stop";
      const reason = startupCancelledError();
      startupController.abort(reason);
      runController.abort(reason);
    };
    options.signal?.addEventListener("abort", callerAborted, { once: true });
    if (options.signal) {
      record.removeCallerAbort = () => options.signal?.removeEventListener("abort", callerAborted);
    }
    this.#generationController.signal.addEventListener("abort", generationAborted, { once: true });
    record.removeGenerationAbort = () =>
      this.#generationController.signal.removeEventListener("abort", generationAborted);

    const startPromise = this.#prepareStart(record, callHandleFactory, preconstructedCallHandle);
    void startPromise.catch(() => undefined);
    return await startPromise;
  }

  async run(options: VoiceAgentRunOptions): Promise<PipelineVoiceLoopResult> {
    const session = await this.start(options);
    return await session.run;
  }

  stop(): Promise<void> {
    if (!this.#stopPromise) {
      this.#lifecycle = "stopping";
      this.#generationController.abort(startupCancelledError());
      for (const record of this.#records) this.#stopRecord(record);
      const gate = this.#stopGate();
      this.#stopPromise = this.#stopWithDeadline(gate);
      void this.#stopPromise.catch(() => undefined);
    }
    return this.#stopPromise;
  }

  async healthCheck(): Promise<HealthSnapshot> {
    const runtime = await this.#runtime.healthCheck();
    const cleanupPending =
      this.#stopLateCleanupPending ||
      [...this.#records].some((record) => record.lateCleanupPending > 0);
    const degraded = this.#stopDegraded || this.#cleanupErrors.length > 0;
    if (!cleanupPending && !degraded) return runtime;
    const message = cleanupPending
      ? "Voice runtime shutdown has cleanup still in progress"
      : "Voice runtime observed a cleanup failure";
    return {
      ok: runtime.ok && !cleanupPending && !degraded,
      checks: {
        ...(runtime.checks ?? {}),
        cleanup: {
          ok: false,
          message,
          details: {
            degraded,
            lateCleanupPending: cleanupPending,
            cleanupErrors: this.#cleanupErrors.slice(0, 8),
          },
        },
      },
    };
  }

  async #prepareStart(
    record: ManagedStartRecord,
    callHandleFactory: VoiceAgentCallHandleFactory | undefined,
    preconstructedCallHandle: CallHandle | undefined,
  ): Promise<VoiceAgentSession> {
    record.state = "starting";
    let provisionalCall: Call;
    const channel = record.options.channel ?? defaultChannel(this.#resolved.telephony);
    if (record.options.call !== undefined) {
      provisionalCall = record.options.call;
    } else {
      if (!preconstructedCallHandle) {
        const error = configurationError("call is required when callHandle is a factory");
        record.startupError = error;
        this.#requestCleanup(record);
        throw error;
      }
      provisionalCall = defaultCall(
        this.#resolved.telephony,
        preconstructedCallHandle,
        this.#resolved.agent.audioPolicy,
      );
    }

    try {
      await this.#awaitStartup(record, this.#ensureRuntimeStarted());
      this.#assertStartupOpen(record);
      const attachmentPromise = this.#runtime.startAttachedSession(this.#resolved.agent, {
        channel,
        call: provisionalCall,
        ...(record.options.variables ? { variables: record.options.variables } : {}),
        ...(record.options.metadata ? { metadata: record.options.metadata } : {}),
        ...(record.options.memoryUserId ? { memoryUserId: record.options.memoryUserId } : {}),
        ...(record.options.organizationId ? { organizationId: record.options.organizationId } : {}),
        ...(record.options.workflowId ? { workflowId: record.options.workflowId } : {}),
      });
      const attachment = await this.#awaitStartup(record, attachmentPromise, (lateAttachment) =>
        this.#cleanupLateAttachment(record, lateAttachment),
      );
      record.attachment = attachment;
      record.state = "attached";
      this.#assertStartupOpen(record);

      let callHandle: CallHandle;
      if (callHandleFactory) {
        const factoryPromise = Promise.resolve().then(() =>
          callHandleFactory({
            sessionId: attachment.session.id,
            call: provisionalCall,
            channel,
            signal: record.factorySignal,
          }),
        );
        callHandle = await this.#awaitStartup(record, factoryPromise, (lateHandle) =>
          this.#cleanupLateHandle(record, lateHandle),
        );
      } else {
        if (!preconstructedCallHandle) {
          throw configurationError("callHandle must be a handle or factory");
        }
        callHandle = preconstructedCallHandle;
      }
      validateCallHandle(callHandle);
      record.callHandle = callHandle;
      record.handleAccepted = true;
      validateCallHandleMatchesCall(provisionalCall, callHandle);
      this.#assertStartupOpen(record);
      record.state = "deferred";
      this.#clearStartupDeadline(record);

      const controller: ManagedRunController = {
        claim: (kind) => this.#claimRun(record, kind),
        cancel: () => this.#cancelRun(record),
      };
      record.run = new ManagedVoiceAgentRun(attachment.session.id, controller);
      return { sessionId: attachment.session.id, run: record.run };
    } catch (error) {
      const startupError = this.#startupFailure(record, error);
      record.startupError = startupError;
      await this.#finalizeStartup(record, startupError).catch((cleanupError) => {
        record.startupError =
          cleanupError instanceof TvicThrowableError
            ? cleanupError
            : TvicThrowableError.from(cleanupError);
      });
      throw record.startupError;
    }
  }

  #claimRun(record: ManagedStartRecord, kind: "internal" | "public"): ManagedRunClaim {
    if (record.claimKind !== undefined) {
      if (record.claimKind === "internal" && kind === "public") {
        throw protocolError();
      }
      if (kind === "public") {
        throw protocolError();
      }
      if (!record.completion) throw startupCancelledError();
      return { completion: record.completion };
    }
    if (record.state === "stopped_unclaimed" || record.startupError) {
      const error = record.startupError ?? startupCancelledError();
      if (!record.completion) {
        record.completion = Promise.reject(error);
        void record.completion.catch(() => undefined);
      }
      return { completion: record.completion };
    }
    if (record.state !== "deferred" || !record.attachment || !record.callHandle) {
      const error = startupCancelledError();
      record.startupError = error;
      record.completion = Promise.reject(error);
      void record.completion.catch(() => undefined);
      return { completion: record.completion };
    }

    record.claimKind = kind;
    record.state = kind === "public" ? "claimed_public" : "claimed_internal";
    try {
      // Session metadata is part of the per-run contract. Providers receive
      // the resolved agent metadata when the pipeline opens their streams, so
      // merge run metadata into a short-lived agent view instead of mutating
      // the shared agent used by concurrent calls.
      const runAgent: Agent =
        record.options.metadata === undefined
          ? this.#resolved.agent
          : {
              ...this.#resolved.agent,
              metadata: {
                ...(this.#resolved.agent.metadata ?? {}),
                ...record.options.metadata,
              },
            };
      const loopOptions = {
        runtime: this.#runtime,
        session: record.attachment.session,
        attachment: record.attachment,
        agent: runAgent,
        callHandle: record.callHandle,
        llmModel: this.#resolved.llm.model,
        sttModel: this.#resolved.stt.model,
        ttsModel: this.#resolved.tts.model,
        ...(this.#resolved.stt.allowUnknownModel ? { sttAllowUnknownModel: true } : {}),
        ...(this.#resolved.tts.voice !== undefined ? { ttsVoice: this.#resolved.tts.voice } : {}),
        ...(record.options.sttReconnect !== undefined
          ? { sttReconnect: record.options.sttReconnect }
          : {}),
        ...(record.options.sttLanguage !== undefined
          ? { sttLanguage: record.options.sttLanguage }
          : {}),
        ...(record.options.safetyIdentifier !== undefined
          ? { safetyIdentifier: record.options.safetyIdentifier }
          : {}),
        ...(record.options.textDelivery !== undefined
          ? { textDelivery: record.options.textDelivery }
          : {}),
        ...(record.options.streamStallTimeoutMs !== undefined
          ? { streamStallTimeoutMs: record.options.streamStallTimeoutMs }
          : {}),
        ...(record.options.turnEndpointTimeoutMs !== undefined
          ? { turnEndpointTimeoutMs: record.options.turnEndpointTimeoutMs }
          : {}),
        ...(record.options.turnMaxDurationMs !== undefined
          ? { turnMaxDurationMs: record.options.turnMaxDurationMs }
          : {}),
        terminalSourceForCancellation: () => {
          if (record.cancelSource === "caller_abort") return "caller_abort" as const;
          if (record.cancelSource === "operator_stop") return "operator_stop" as const;
          return undefined;
        },
      } satisfies PipelineVoiceLoopOptions;
      const loop = new PipelineVoiceLoop(loopOptions);
      let rawPromise: Promise<PipelineVoiceLoopResult> | undefined;
      const raw = loop._startInternal({
        overrideSignal: record.runSignal,
        consumer: kind,
        onRunPromise: (promise) => {
          rawPromise = promise;
        },
      });
      record.raw = raw;
      record.state = "running";
      if (!rawPromise) {
        throw TvicThrowableError.from(
          internalError(
            "voice_runtime.start_failed",
            "The pipeline did not expose its managed completion promise",
          ),
        );
      }
      const completion = rawPromise.then(
        async (result) => {
          await this.#finalizeRun(record, { result });
          if (result.terminalReason === "cancelled") {
            throw this.#runCancellationError(record);
          }
          if (result.terminalReason === "remote_hangup") {
            throw TvicThrowableError.from(
              cancelledError("voice_runtime.remote_hangup", "The remote caller ended the call"),
            );
          }
          return result;
        },
        async (error: unknown) => {
          try {
            await this.#finalizeRun(record, { error });
          } catch (finalizationError) {
            throw finalizationError;
          }
          throw error;
        },
      );
      record.completion = completion;
      void completion.then(
        () => this.#markRunSettled(record),
        () => this.#markRunSettled(record),
      );
      if (kind === "public") {
        const iterator = raw[Symbol.asyncIterator]();
        record.rawIteratorClaimed = true;
        return { completion, iterator };
      }
      return { completion };
    } catch (error) {
      const completion = Promise.reject(error);
      record.completion = completion;
      void completion.catch(() => undefined);
      void this.#finalizeRun(record, { error }).catch(() => undefined);
      return { completion };
    }
  }

  #cancelRun(record: ManagedStartRecord): void {
    if (record.state === "deferred") {
      this.#stopDeferredRecord(record);
      return;
    }
    record.cancelSource ??= "operator_stop";
    record.runController.abort(startupCancelledError());
  }

  #stopRecord(record: ManagedStartRecord): void {
    if (record.state === "settled" || record.state === "finalizing") return;
    if (record.state === "deferred") {
      this.#stopDeferredRecord(record);
      return;
    }
    record.cancelSource = "operator_stop";
    record.startupController.abort(startupCancelledError());
    record.runController.abort(startupCancelledError());
  }

  #stopDeferredRecord(record: ManagedStartRecord): void {
    if (record.state !== "deferred") return;
    record.state = "stopped_unclaimed";
    const error = startupCancelledError();
    record.startupError = error;
    record.completion = Promise.reject(error);
    void record.completion.catch(() => undefined);
    void this.#finalizeStartup(record, error).catch(() => undefined);
  }

  async #ensureRuntimeStarted(): Promise<void> {
    if (this.#lifecycle !== "accepting") throw startupCancelledError();
    if (this.#runtimeStartPromise) return this.#runtimeStartPromise;
    this.#runtimeStartInvoked = true;
    this.#runtimeStartState = "starting";
    const starting = Promise.resolve()
      .then(() => this.#runtime.start(this.#generationController.signal))
      .then(
        () => {
          this.#runtimeStartState = "fulfilled";
          this.#runtimeStarted = true;
        },
        (error: unknown) => {
          this.#runtimeStartState = "rejected";
          if (this.#lifecycle === "accepting") {
            this.#runtimeStartPromise = undefined;
            this.#runtimeStarted = false;
          }
          throw TvicThrowableError.from(
            normalizeUnknownError(error, {
              code: "voice_runtime.runtime_start_failed",
              category: "internal",
              retriable: false,
            }),
          );
        },
      );
    this.#runtimeStartPromise = starting;
    void starting.catch(() => undefined);
    return starting;
  }

  async #awaitStartup<T>(
    record: ManagedStartRecord,
    operation: PromiseLike<T>,
    onLate?: (value: T) => void | PromiseLike<void>,
  ): Promise<T> {
    const promise = nativePromiseFromThenable(operation);
    void promise.catch(() => undefined);
    let removeAbortListener: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      if (record.factorySignal.aborted) {
        reject(this.#startupFailure(record));
        return;
      }
      const abort = () => reject(this.#startupFailure(record));
      record.factorySignal.addEventListener("abort", abort, { once: true });
      removeAbortListener = () => record.factorySignal.removeEventListener("abort", abort);
    });
    try {
      return await Promise.race([promise, aborted]);
    } catch (error) {
      if (record.factorySignal.aborted) {
        if (onLate) {
          this.#trackLateCleanup(
            record,
            promise.then(
              (value) => onLate(value),
              () => undefined,
            ),
          );
        }
        throw this.#startupFailure(record, error);
      }
      throw error;
    } finally {
      removeAbortListener?.();
    }
  }

  #assertStartupOpen(record: ManagedStartRecord): void {
    if (record.factorySignal.aborted || this.#lifecycle !== "accepting") {
      throw this.#startupFailure(record);
    }
  }

  #startupFailure(record: ManagedStartRecord, error?: unknown): TvicThrowableError {
    if (record.cancelSource !== undefined || this.#lifecycle !== "accepting") {
      return startupCancelledError();
    }
    if (record.timeoutExpired) return startupTimeoutError(record.startupTimeoutMs);
    if (error instanceof TvicThrowableError) return error;
    return TvicThrowableError.from(
      normalizeUnknownError(error, {
        code: "voice_runtime.start_failed",
        category: "internal",
        retriable: false,
      }),
    );
  }

  #clearStartupDeadline(record: ManagedStartRecord): void {
    if (record.startupTimer) clearTimeout(record.startupTimer);
    record.startupTimer = undefined;
  }

  #requestForTerminalSource(
    source: "caller_abort" | "operator_stop",
  ): Extract<EndSessionRequest, { readonly reason: "cancelled" }> {
    if (source === "caller_abort") {
      return { reason: "cancelled", cancelReason: "caller_hangup", terminalSource: source };
    }
    return {
      reason: "cancelled",
      cancelReason: "operator_requested",
      terminalSource: source,
    };
  }

  #claimRunCancellationSource(record: ManagedStartRecord): EndSessionRequest {
    if (record.cancelSource === "caller_abort") {
      return this.#requestForTerminalSource("caller_abort");
    }
    if (record.cancelSource === "operator_stop") {
      return this.#requestForTerminalSource("operator_stop");
    }
    return {
      reason: "cancelled",
      cancelReason: "operator_requested",
      terminalSource: "legacy_unknown",
    };
  }

  #runCancellationError(
    record: ManagedStartRecord,
    source?: "caller_abort" | "operator_stop",
  ): TvicThrowableError {
    const request = source
      ? this.#requestForTerminalSource(source)
      : this.#claimRunCancellationSource(record);
    const terminalSource = request.terminalSource;
    if (terminalSource === "caller_abort") {
      return TvicThrowableError.from(
        cancelledError("voice_runtime.run_cancelled", "The voice pipeline was cancelled"),
      );
    }
    return TvicThrowableError.from(
      cancelledError("voice_runtime.run_stopped", "The voice pipeline was cancelled"),
    );
  }

  async #finalizeStartup(record: ManagedStartRecord, primary: TvicThrowableError): Promise<void> {
    if (record.finalization) return record.finalization;
    this.#clearStartupDeadline(record);
    record.state = "finalizing";
    const request: EndSessionRequest =
      record.cancelSource === "caller_abort"
        ? { reason: "cancelled", cancelReason: "caller_hangup", terminalSource: "caller_abort" }
        : record.cancelSource === "operator_stop" || this.#lifecycle !== "accepting"
          ? {
              reason: "cancelled",
              cancelReason: "operator_requested",
              terminalSource: "operator_stop",
            }
          : primary.category === "timeout"
            ? { reason: "timeout", error: primary.error, terminalSource: "run_timeout" }
            : { reason: "failed", error: primary.error, terminalSource: "provider_runtime" };
    const finalization = this.#cleanupRecord(
      record,
      request,
      request.reason === "cancelled" ? "cancelled" : "error",
      primary,
    );
    record.finalization = finalization;
    try {
      await finalization;
    } finally {
      record.state = "settled";
      this.#requestCleanup(record);
    }
  }

  async #finalizeRun(
    record: ManagedStartRecord,
    outcome: { readonly result?: PipelineVoiceLoopResult; readonly error?: unknown },
  ): Promise<void> {
    if (record.finalization) return record.finalization;
    record.state = "finalizing";
    let request: EndSessionRequest;
    let closeReason: "completed" | "cancelled" | "timeout" | "error";
    let primary: ReturnType<typeof normalizeUnknownError> | null = null;
    if (outcome.result) {
      if (outcome.result.terminalSource === "remote_transport") {
        primary = cancelledError("voice_runtime.remote_hangup", "The remote caller ended the call");
        request = {
          reason: "cancelled",
          cancelReason: "transport_lost",
          terminalSource: "remote_transport",
        };
        closeReason = "cancelled";
      } else if (
        outcome.result.terminalSource === "caller_abort" ||
        outcome.result.terminalSource === "operator_stop"
      ) {
        primary = this.#runCancellationError(record, outcome.result.terminalSource).error;
        request = this.#requestForTerminalSource(outcome.result.terminalSource);
        closeReason = "cancelled";
      } else if (outcome.result.terminalSource === "run_timeout") {
        primary =
          outcome.result.firstTurnError ??
          timeoutError("voice_runtime.run_timeout", "The voice pipeline exceeded its timeout");
        request = { reason: "timeout", error: primary, terminalSource: "run_timeout" };
        closeReason = "timeout";
      } else if (
        outcome.result.terminalSource === "provider_runtime" ||
        outcome.result.turnsFailed > 0 ||
        outcome.result.terminalReason === "failed"
      ) {
        primary =
          outcome.result.firstTurnError ??
          internalError("voice_runtime.turn_failed", "One or more voice turns failed");
        request = { reason: "failed", error: primary, terminalSource: "provider_runtime" };
        closeReason = "error";
      } else {
        request = { reason: "completed", terminalSource: "normal_completion" };
        closeReason = "completed";
      }
    } else {
      primary = normalizeUnknownError(outcome.error, {
        code: "voice_runtime.run_failed",
        category: "internal",
        retriable: false,
      });
      if (primary.category === "timeout") {
        request = { reason: "timeout", error: primary, terminalSource: "run_timeout" };
        closeReason = "timeout";
      } else if (record.cancelSource !== undefined) {
        request = this.#requestForTerminalSource(
          record.cancelSource === "caller_abort" ? "caller_abort" : "operator_stop",
        );
        closeReason = "cancelled";
      } else if (record.attachment?.signal.aborted) {
        request = {
          reason: "cancelled",
          cancelReason: "transport_lost",
          terminalSource: "remote_transport",
        };
        primary = cancelledError("voice_runtime.remote_hangup", "The remote caller ended the call");
        closeReason = "cancelled";
      } else if (primary.category === "cancelled") {
        request = this.#requestForTerminalSource("caller_abort");
        closeReason = "cancelled";
      } else {
        request = { reason: "failed", error: primary, terminalSource: "provider_runtime" };
        closeReason = "error";
      }
    }
    const finalization = this.#cleanupRecord(record, request, closeReason, primary);
    record.finalization = finalization;
    try {
      await finalization;
    } finally {
      record.state = "settled";
      this.#requestCleanup(record);
    }
  }

  #cleanupRecord(
    record: ManagedStartRecord,
    request: EndSessionRequest,
    closeReason: "completed" | "cancelled" | "timeout" | "error",
    primary: ReturnType<typeof normalizeUnknownError> | null,
  ): Promise<void> {
    const close = record.handleAccepted
      ? this.#closeAcceptedHandle(record, closeReason)
      : Promise.resolve();
    const end = record.attachment
      ? Promise.resolve().then(() =>
          this.#runtime.endSession(record.attachment!.session.id, request),
        )
      : Promise.resolve();
    let callClosed = !record.handleAccepted;
    let sessionEnded = !record.attachment;
    const errors: ReturnType<typeof cleanupErrorSummary>[] = [];
    const observeClose = close.then(
      () => {
        callClosed = true;
      },
      (error) => {
        const summary = cleanupErrorSummary("call.close", error);
        errors.push(summary);
        this.#rememberCleanupError(summary);
      },
    );
    const observeEnd = end.then(
      () => {
        sessionEnded = true;
      },
      (error) => {
        const summary = cleanupErrorSummary("runtime.endSession", error);
        errors.push(summary);
        this.#rememberCleanupError(summary);
      },
    );
    const barrier = Promise.allSettled([observeClose, observeEnd]).then(() => undefined);
    record.cleanupBarrier = barrier;
    const cleanupDone = barrier.then(() => {
      record.cleanupErrors.push(...errors.slice(0, 8 - record.cleanupErrors.length));
    });
    this.#requestCleanupAfter(record, cleanupDone);
    return (async () => {
      const winner = await Promise.race([
        barrier.then(() => "settled" as const),
        timeoutPromise(MANAGED_STOP_DRAIN_TIMEOUT_MS),
      ]);
      if (winner === "timeout") {
        this.#stopLateCleanupPending = true;
        this.#stopDegraded = true;
        throw new VoiceRuntimeFinalizationError(primary, errors, {
          degraded: true,
          callClosed,
          sessionEnded,
          timedOut: true,
          lateCleanupPending: true,
          primaryCode: primary?.code ?? "voice_runtime.start_cancelled",
          cleanupErrors: errors,
        });
      }
      if (errors.length > 0) {
        this.#stopDegraded = true;
        throw new VoiceRuntimeFinalizationError(primary, errors, {
          degraded: true,
          callClosed,
          sessionEnded,
          timedOut: false,
          lateCleanupPending: false,
          primaryCode: primary?.code ?? "voice_runtime.run_completed",
          cleanupErrors: errors,
        });
      }
    })();
  }

  #closeAcceptedHandle(
    record: ManagedStartRecord,
    reason: "completed" | "cancelled" | "timeout" | "error",
  ): Promise<void> {
    if (!record.callHandle || !record.handleAccepted) return Promise.resolve();
    if (!record.closePromise) {
      record.closePromise = Promise.resolve().then(() => {
        const close = dataProperty(record.callHandle!, "close");
        if (typeof close !== "function") {
          throw internalError("voice_runtime.invalid_config", "Accepted call handle lost close()");
        }
        return Reflect.apply(close, record.callHandle, [reason]);
      });
      void record.closePromise.catch(() => undefined);
    }
    return record.closePromise;
  }

  #cleanupLateAttachment(
    _record: ManagedStartRecord,
    attachment: SessionAttachment,
  ): Promise<void> {
    return Promise.resolve()
      .then(() =>
        this.#runtime.endSession(attachment.session.id, {
          reason: "cancelled",
          cancelReason: "operator_requested",
          terminalSource: "runtime_shutdown",
        }),
      )
      .then(
        () => undefined,
        (error) => {
          const summary = cleanupErrorSummary("late.runtime.endSession", error);
          this.#rememberCleanupError(summary);
        },
      );
  }

  #cleanupLateHandle(_record: ManagedStartRecord, value: unknown): Promise<void> {
    if (!isCallHandle(value)) return Promise.resolve();
    return Promise.resolve()
      .then(() => {
        const close = dataProperty(value, "close");
        if (typeof close !== "function") return;
        return Reflect.apply(close, value, ["cancelled"]);
      })
      .then(
        () => undefined,
        (error) => {
          const summary = cleanupErrorSummary("late.call.close", error);
          this.#rememberCleanupError(summary);
        },
      );
  }

  #trackLateCleanup(record: ManagedStartRecord, promise: PromiseLike<unknown>): void {
    record.lateCleanupPending += 1;
    void nativePromiseFromThenable(promise).then(
      () => {
        record.lateCleanupPending = Math.max(0, record.lateCleanupPending - 1);
        this.#maybeResolveCleanup(record);
      },
      () => {
        record.lateCleanupPending = Math.max(0, record.lateCleanupPending - 1);
        this.#maybeResolveCleanup(record);
      },
    );
  }

  #requestCleanup(record: ManagedStartRecord): void {
    record.cleanupReadyRequested = true;
    this.#maybeResolveCleanup(record);
  }

  #requestCleanupAfter(record: ManagedStartRecord, barrier: PromiseLike<unknown>): void {
    void nativePromiseFromThenable(barrier).then(
      () => this.#requestCleanup(record),
      () => this.#requestCleanup(record),
    );
  }

  #maybeResolveCleanup(record: ManagedStartRecord): void {
    if (record.cleanupReadyRequested && record.lateCleanupPending === 0) {
      this.#removeRecordAbortListeners(record);
      record.cleanup.resolve(undefined);
      this.#records.delete(record);
      if (this.#lifecycle === "stopping" && this.#records.size === 0) {
        this.#stopLateCleanupPending = false;
      }
    }
  }

  #removeRecordAbortListeners(record: ManagedStartRecord): void {
    record.removeCallerAbort?.();
    record.removeGenerationAbort?.();
    record.removeCallerAbort = undefined;
    record.removeGenerationAbort = undefined;
  }

  #markRunSettled(record: ManagedStartRecord): void {
    if (!record.finalization && record.state !== "settled") record.state = "settled";
  }

  #rememberCleanupError(error: ReturnType<typeof cleanupErrorSummary>): void {
    if (this.#cleanupErrors.length < 8) this.#cleanupErrors.push(error);
    this.#stopDegraded = true;
  }

  async #stopGate(): Promise<void> {
    const start = this.#runtimeStartPromise;
    let startFulfilled = this.#runtimeStartState === "fulfilled";
    if (start) {
      try {
        await start;
        startFulfilled = true;
      } catch {
        startFulfilled = false;
      }
    }
    await this.#waitForRecords();
    if (!this.#runtimeStartInvoked || !startFulfilled || !this.#runtimeStarted) return;
    try {
      await this.#runtime.stop();
    } catch (error) {
      const summary = cleanupErrorSummary("runtime.stop", error);
      this.#rememberCleanupError(summary);
      throw new VoiceRuntimeFinalizationError(null, [summary], {
        degraded: true,
        callClosed: true,
        sessionEnded: true,
        timedOut: false,
        lateCleanupPending: false,
        primaryCode: "voice_runtime.shutdown_failed",
        cleanupErrors: [summary],
      });
    }
  }

  async #waitForRecords(): Promise<void> {
    while (this.#records.size > 0) {
      const records = [...this.#records];
      await Promise.allSettled(records.map((record) => record.cleanup.promise));
    }
  }

  async #stopWithDeadline(gate: Promise<void>): Promise<void> {
    try {
      const winner = await Promise.race([
        gate.then(
          () => "settled" as const,
          (error) => Promise.reject(error),
        ),
        timeoutPromise(MANAGED_STOP_DRAIN_TIMEOUT_MS),
      ]);
      if (winner === "timeout") {
        this.#stopDegraded = true;
        this.#stopLateCleanupPending = true;
        void gate.then(
          () => {
            this.#stopLateCleanupPending = false;
          },
          (error) => {
            this.#stopLateCleanupPending = false;
            this.#stopDegraded = true;
            this.#rememberCleanupError(cleanupErrorSummary("runtime.stop", error));
          },
        );
        throw TvicThrowableError.from(
          internalError(
            "voice_runtime.shutdown_failed",
            "Voice agent shutdown exceeded its deadline",
            {
              metadata: {
                degraded: true,
                timedOut: true,
                lateCleanupPending: true,
              },
            },
          ),
        );
      }
    } catch (error) {
      this.#lifecycle = "stopped";
      throw error;
    }
    this.#lifecycle = "stopped";
  }
}

export function createVoiceAgent(options: CreateVoiceAgentOptions): VoiceAgent {
  return new ManagedVoiceAgent(options);
}

export type { TwilioMediaStreamSocket };
