import type { AudioFormat } from "./audio.js";
import type { TtsTextControlKind } from "./providers/tts-text-controls.js";
import { TVIC_ERROR_CODES } from "./constants.js";
import {
  MAX_PROVIDER_CAPABILITY_IDENTIFIER_LENGTH,
  type ProviderCapabilityQuery,
} from "./provider-capability-snapshot.js";

export type ProviderKind = "telephony" | "stt" | "tts" | "llm" | "storage";

/** Transports TVIC 1.0 executes. gRPC/http2 arrive with the SDK-based STT wave. */
export type ProviderTransport = "http" | "sse" | "websocket";

export type TurnDetectionMode = "provider" | "stt_endpointing" | "vad" | "semantic" | "manual";
export type TurnTakingProfile = "latency" | "balanced" | "accuracy";

export type ProviderDataPolicy = "standard" | "no_training" | "zero_retention";

export type CallControlCapability =
  | "inbound"
  | "outbound"
  | "reject"
  | "progress"
  | "dtmf_receive"
  | "dtmf_send"
  | "transfer_blind"
  | "transfer_consult"
  | "early_media"
  | "conference";

export interface ProviderStreamingCapabilities {
  /** Accepts incremental input instead of requiring a complete request payload. */
  readonly input: boolean;

  /** Produces incremental output instead of one complete response payload. */
  readonly output: boolean;

  /** Streaming is supported by the provider protocol, not emulated by chunked requests. */
  readonly native: boolean;
}

export interface ProviderBatchCapabilities {
  /** Accepts one complete input payload instead of requiring a live stream. */
  readonly input: boolean;

  /** Returns one complete output payload instead of incremental events. */
  readonly output: boolean;
}

export interface ProviderCancellationCapabilities {
  /** Active provider work can be stopped rather than merely ignored by TVIC. */
  readonly request: boolean;

  /** In-progress generated output can be stopped. */
  readonly output: boolean;

  /** Already queued transport audio can be removed before playout. */
  readonly buffer: boolean;

  /** Provider conversation state can be truncated to the audio actually played. */
  readonly truncation: boolean;
}

export interface ProviderAudioCapabilities {
  /** Formats accepted at the TVIC adapter boundary after any wire decoding. */
  readonly input?: readonly AudioFormat[];

  /** Formats emitted at the TVIC adapter boundary before any wire encoding. */
  readonly output?: readonly AudioFormat[];
}

export interface ProviderToolCapabilities {
  readonly functionCalling: boolean;
  readonly parallelCalls: boolean;
}

export interface ProviderPlayoutCapabilities {
  /** The transport can remove queued output that has not played. */
  readonly clearBuffer: boolean;

  /** The transport acknowledges a marker after preceding audio is consumed. */
  readonly acknowledgement: boolean;

  /** The transport reports an exact played position, not only a marker boundary. */
  readonly position: boolean;
}

export interface ProviderTurnProfileCapability {
  readonly model: string;
  readonly profiles: readonly TurnTakingProfile[];
}

export interface ProviderTtsTextControlCapability {
  readonly model: string;
  readonly controls: readonly TtsTextControlKind[];
}

export interface ProviderTtsSpeedRange {
  readonly model: string;
  readonly min: number;
  readonly max: number;
}

export const MAX_PROVIDER_TTS_SPEED_RANGES = 64;

export interface ProviderTtsVoiceCapabilityRequirement {
  readonly provider?: string;
  readonly feature: string;
  readonly configuredLanguage?: string;
  readonly expectedBooleanValue?: boolean;
  readonly voiceSource?: "requested" | "mapped";
  readonly modelSource?: "selected" | "mapped";
  readonly configuredLanguageMustBeVerified?: boolean;
}

export type ProviderVoiceSelection = "account_snapshot";

export const MAX_PROVIDER_TTS_VOICE_MAPPINGS = 64;

export interface ProviderTtsVoiceMapping {
  readonly requestedModel?: string;
  readonly requestedVoice?: string;
  /** Provider that receives the requested model and voice before fallback mapping. */
  readonly requestedProvider?: string;
  readonly provider: string;
  readonly model?: string;
  readonly voice: string;
}

export function createProviderTtsVoiceMappings(value: unknown): readonly ProviderTtsVoiceMapping[] {
  if (!Array.isArray(value) || value.length > MAX_PROVIDER_TTS_VOICE_MAPPINGS) {
    throw new TypeError(
      `TTS voice mappings must contain at most ${MAX_PROVIDER_TTS_VOICE_MAPPINGS} entries`,
    );
  }

  const seen = new Set<string>();
  const mappings = value.map((mapping): ProviderTtsVoiceMapping => {
    if (typeof mapping !== "object" || mapping === null || Array.isArray(mapping)) {
      throw new TypeError("TTS voice mapping must be an object");
    }
    const candidate = mapping as Record<string, unknown>;
    for (const [name, identifier] of [
      ["provider", candidate.provider],
      ["voice", candidate.voice],
    ] as const) {
      assertTtsMappingIdentifier(identifier, name);
    }
    for (const [name, identifier] of [
      ["requestedProvider", candidate.requestedProvider],
      ["requestedModel", candidate.requestedModel],
      ["requestedVoice", candidate.requestedVoice],
      ["model", candidate.model],
    ] as const) {
      if (identifier !== undefined) assertTtsMappingIdentifier(identifier, name);
    }

    const selector = JSON.stringify([
      candidate.requestedModel ?? null,
      candidate.requestedVoice ?? null,
    ]);
    if (seen.has(selector)) {
      throw new TypeError("TTS voice mappings must have unique request selectors");
    }
    seen.add(selector);
    return Object.freeze({
      ...(candidate.requestedModel !== undefined
        ? { requestedModel: candidate.requestedModel as string }
        : {}),
      ...(candidate.requestedVoice !== undefined
        ? { requestedVoice: candidate.requestedVoice as string }
        : {}),
      ...(candidate.requestedProvider !== undefined
        ? { requestedProvider: candidate.requestedProvider as string }
        : {}),
      provider: candidate.provider as string,
      ...(candidate.model !== undefined ? { model: candidate.model as string } : {}),
      voice: candidate.voice as string,
    });
  });

  return Object.freeze(mappings);
}

function assertTtsMappingIdentifier(value: unknown, name: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > MAX_PROVIDER_CAPABILITY_IDENTIFIER_LENGTH ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError(`TTS voice mapping ${name} is invalid`);
  }
}

/**
 * Capabilities describe one configured adapter/deployment, not every feature sold by
 * the provider. Mutable catalog facts may be omitted until they are verified.
 */
export interface ProviderCapabilities {
  readonly streaming: ProviderStreamingCapabilities;
  readonly batch?: ProviderBatchCapabilities;
  readonly cancellation: ProviderCancellationCapabilities;
  readonly transports: readonly ProviderTransport[];
  readonly audio?: ProviderAudioCapabilities;
  readonly languages?: readonly string[];
  readonly models?: readonly string[];
  readonly batchModels?: readonly string[];
  readonly voices?: readonly string[];

  /** Whether an incremental TTS adapter can honor timestamp/alignment requests. */
  readonly timestamps?: boolean;
  readonly turnDetection?: readonly TurnDetectionMode[];
  readonly turnProfiles?: readonly ProviderTurnProfileCapability[];
  readonly ttsTextControls?: readonly ProviderTtsTextControlCapability[];
  readonly ttsSpeedRanges?: readonly ProviderTtsSpeedRange[];
  readonly voiceSelection?: ProviderVoiceSelection;
  readonly voiceSnapshotProviders?: readonly string[];
  readonly modelSnapshotProviders?: readonly string[];
  readonly ttsVoiceMappings?: readonly ProviderTtsVoiceMapping[];
  readonly tools?: ProviderToolCapabilities;
  readonly playout?: ProviderPlayoutCapabilities;
  readonly callControl?: readonly CallControlCapability[];
  readonly regions?: readonly string[];
  readonly dataPolicies?: readonly ProviderDataPolicy[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface Provider {
  readonly name: string;
  readonly kind: ProviderKind;
  readonly version: string;
  readonly capabilities: ProviderCapabilities;
  readonly configuredModel?: string;

  /** Skip local model-catalog validation; this does not imply vendor support. */
  readonly allowUnknownModel?: boolean;
  readonly configuredVoice?: string | undefined;
  readonly configuredLanguage?: string | undefined;
  readonly languageWasExplicitlyConfigured?: boolean;
  readonly supportsLanguage?: (language: string, model?: string, voice?: string) => boolean;
  readonly supportsVoice?: (voice: string, model?: string) => boolean;
  readonly requiredCapabilityQueries?: readonly ProviderCapabilityQuery[] | undefined;
  readonly requiredCapabilityQueriesForModel?: (
    model: string,
    voice?: string,
  ) => readonly ProviderCapabilityQuery[];
  readonly supportsConfiguredModelSelection?: (model: string, voice?: string) => boolean;
  readonly requiredTtsVoiceCapabilities?:
    | readonly ProviderTtsVoiceCapabilityRequirement[]
    | undefined;
  readonly region?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * A requirement is opt-in: a present flag can only mean "must be supported".
 * Callers omit capabilities they do not require instead of passing a misleading
 * `false` that could be read as "must not support".
 */
export type RequiredProviderCapabilities<T extends object> = {
  readonly [K in keyof T]?: true;
};

export interface ProviderRequirements {
  readonly kind: ProviderKind;
  readonly streaming?: RequiredProviderCapabilities<ProviderStreamingCapabilities>;
  readonly batch?: RequiredProviderCapabilities<ProviderBatchCapabilities>;
  readonly cancellation?: RequiredProviderCapabilities<ProviderCancellationCapabilities>;
  readonly transport?: ProviderTransport;
  readonly inputFormat?: AudioFormat;
  readonly outputFormat?: AudioFormat;
  readonly language?: string;
  readonly model?: string;
  readonly batchModel?: string;
  readonly voice?: string;
  readonly turnDetection?: TurnDetectionMode;
  readonly turnProfile?: TurnTakingProfile;
  readonly ttsTextControls?: readonly TtsTextControlKind[];
  readonly ttsSpeed?: number;
  readonly functionCalling?: boolean;
  readonly parallelToolCalls?: boolean;
  readonly playout?: RequiredProviderCapabilities<ProviderPlayoutCapabilities>;
  readonly callControl?: readonly CallControlCapability[];
  readonly region?: string;
  readonly dataPolicy?: ProviderDataPolicy;
}

export type ProviderCompatibilityIssueCode =
  | "kind.unsupported"
  | "streaming.unsupported"
  | "batch.unsupported"
  | "cancellation.unsupported"
  | "transport.unsupported"
  | "audio.input_unsupported"
  | "audio.output_unsupported"
  | "language.unsupported"
  | "provider.model_unsupported"
  | "provider.voice_unsupported"
  | "turn_detection.unsupported"
  | "turn_profile.unsupported"
  | "tts_text_control.unsupported"
  | "tts_speed.unsupported"
  | "tools.unsupported"
  | "playout.unsupported"
  | "call_control.unsupported"
  | "region.unsupported"
  | "data_policy.unsupported";

export interface ProviderCompatibilityIssue {
  readonly code: ProviderCompatibilityIssueCode;
  readonly requirement: string;
  readonly message: string;
}

export type ProviderCompatibility =
  | { readonly compatible: true; readonly issues: readonly [] }
  | { readonly compatible: false; readonly issues: readonly ProviderCompatibilityIssue[] };

export function evaluateProviderCompatibility(
  provider: Provider,
  requirements: ProviderRequirements,
): ProviderCompatibility {
  const issues: ProviderCompatibilityIssue[] = [];
  const capabilities = provider.capabilities;

  if (provider.kind !== requirements.kind) {
    issue(
      issues,
      "kind.unsupported",
      "kind",
      `${provider.name} is ${provider.kind}, not ${requirements.kind}`,
    );
  }

  checkRequiredBooleans(
    issues,
    "streaming.unsupported",
    "streaming",
    requirements.streaming,
    capabilities.streaming,
    provider.name,
  );
  checkRequiredBooleans(
    issues,
    "batch.unsupported",
    "batch",
    requirements.batch,
    capabilities.batch,
    provider.name,
  );
  checkRequiredBooleans(
    issues,
    "cancellation.unsupported",
    "cancellation",
    requirements.cancellation,
    capabilities.cancellation,
    provider.name,
  );
  checkRequiredBooleans(
    issues,
    "playout.unsupported",
    "playout",
    requirements.playout,
    capabilities.playout,
    provider.name,
  );

  if (requirements.transport && !capabilities.transports.includes(requirements.transport)) {
    issue(
      issues,
      "transport.unsupported",
      "transport",
      `${provider.name} does not support ${requirements.transport}`,
    );
  }
  if (
    requirements.inputFormat &&
    !capabilities.audio?.input?.some((format) => sameAudioFormat(format, requirements.inputFormat!))
  ) {
    issue(
      issues,
      "audio.input_unsupported",
      "inputFormat",
      `${provider.name} does not accept ${describeAudioFormat(requirements.inputFormat)}`,
    );
  }
  if (
    requirements.outputFormat &&
    !capabilities.audio?.output?.some((format) =>
      sameAudioFormat(format, requirements.outputFormat!),
    )
  ) {
    issue(
      issues,
      "audio.output_unsupported",
      "outputFormat",
      `${provider.name} does not emit ${describeAudioFormat(requirements.outputFormat)}`,
    );
  }

  checkMember(
    issues,
    provider.name,
    "language",
    requirements.language,
    capabilities.languages,
    provider.supportsLanguage,
    requirements.model,
    provider,
    requirements.voice,
  );
  if (requirements.turnProfile !== undefined) {
    const model = requirements.model ?? provider.configuredModel;
    const modelProfiles = capabilities.turnProfiles?.find((entry) => entry.model === model);
    if (!modelProfiles?.profiles.includes(requirements.turnProfile)) {
      issue(
        issues,
        "turn_profile.unsupported",
        "turnProfile",
        `${provider.name} does not declare the ${requirements.turnProfile} turn profile for ${model ?? "the selected model"}`,
      );
    }
  }
  for (const textControl of requirements.ttsTextControls ?? []) {
    const model = requirements.model ?? provider.configuredModel;
    const modelControls = capabilities.ttsTextControls?.find((entry) => entry.model === model);
    if (!modelControls?.controls.includes(textControl)) {
      issue(
        issues,
        "tts_text_control.unsupported",
        "ttsTextControls",
        `${provider.name} does not declare the ${textControl} TTS text control for ${model ?? "the selected model"}`,
      );
    }
  }
  if (requirements.ttsSpeed !== undefined) {
    const model = requirements.model ?? provider.configuredModel;
    const speedRange = capabilities.ttsSpeedRanges?.find((entry) => entry.model === model);
    if (
      !Number.isFinite(requirements.ttsSpeed) ||
      !speedRange ||
      !Number.isFinite(speedRange.min) ||
      !Number.isFinite(speedRange.max) ||
      speedRange.min > speedRange.max ||
      requirements.ttsSpeed < speedRange.min ||
      requirements.ttsSpeed > speedRange.max
    ) {
      issue(
        issues,
        "tts_speed.unsupported",
        "ttsSpeed",
        `${provider.name} does not declare support for TTS speed ${requirements.ttsSpeed} on ${model ?? "the selected model"}`,
      );
    }
  }
  checkMember(issues, provider.name, "model", requirements.model, capabilities.models);
  checkMember(
    issues,
    provider.name,
    "batch_model",
    requirements.batchModel,
    capabilities.batchModels,
  );
  checkMember(
    issues,
    provider.name,
    "voice",
    requirements.voice,
    capabilities.voices,
    provider.supportsVoice,
    requirements.model,
    provider,
  );
  checkMember(
    issues,
    provider.name,
    "turn_detection",
    requirements.turnDetection,
    capabilities.turnDetection,
  );
  checkMember(issues, provider.name, "region", requirements.region, capabilities.regions);
  checkMember(
    issues,
    provider.name,
    "data_policy",
    requirements.dataPolicy,
    capabilities.dataPolicies,
  );

  if (requirements.functionCalling && !capabilities.tools?.functionCalling) {
    issue(
      issues,
      "tools.unsupported",
      "functionCalling",
      `${provider.name} does not support function calling`,
    );
  }
  if (requirements.parallelToolCalls && !capabilities.tools?.parallelCalls) {
    issue(
      issues,
      "tools.unsupported",
      "parallelToolCalls",
      `${provider.name} does not support parallel tool calls`,
    );
  }

  for (const capability of requirements.callControl ?? []) {
    if (!capabilities.callControl?.includes(capability)) {
      issue(
        issues,
        "call_control.unsupported",
        `callControl.${capability}`,
        `${provider.name} does not support call control capability ${capability}`,
      );
    }
  }

  return issues.length === 0 ? { compatible: true, issues: [] } : { compatible: false, issues };
}

export function sameAudioFormat(left: AudioFormat, right: AudioFormat): boolean {
  return (
    left.encoding === right.encoding &&
    left.sampleRateHz === right.sampleRateHz &&
    left.channels === right.channels
  );
}

function checkRequiredBooleans<T extends object>(
  issues: ProviderCompatibilityIssue[],
  code: ProviderCompatibilityIssueCode,
  prefix: string,
  required: RequiredProviderCapabilities<T> | undefined,
  available: T | undefined,
  providerName: string,
): void {
  if (!required) {
    return;
  }
  for (const [key, value] of Object.entries(required)) {
    if (value === true && available?.[key as keyof T] !== true) {
      issue(
        issues,
        code,
        `${prefix}.${key}`,
        `${providerName} does not support required capability ${prefix}.${key}`,
      );
    }
  }
}

function checkMember(
  issues: ProviderCompatibilityIssue[],
  providerName: string,
  requirement:
    | "language"
    | "model"
    | "batch_model"
    | "voice"
    | "turn_detection"
    | "region"
    | "data_policy",
  required: string | undefined,
  available: readonly string[] | undefined,
  supports?: (value: string, model?: string, voice?: string) => boolean,
  model?: string,
  supportContext?: Provider,
  voice?: string,
): void {
  if (!required) return;
  if (supports) {
    if (supports.call(supportContext, required, model, voice)) return;
  } else if (available?.includes(required)) {
    return;
  }
  const codeByRequirement = {
    language: "language.unsupported",
    model: TVIC_ERROR_CODES.providerModelUnsupported,
    batch_model: TVIC_ERROR_CODES.providerModelUnsupported,
    voice: TVIC_ERROR_CODES.providerVoiceUnsupported,
    turn_detection: "turn_detection.unsupported",
    region: "region.unsupported",
    data_policy: "data_policy.unsupported",
  } as const;
  issue(
    issues,
    codeByRequirement[requirement],
    requirement,
    `${providerName} does not support ${requirement} ${required}`,
  );
}

function issue(
  issues: ProviderCompatibilityIssue[],
  code: ProviderCompatibilityIssueCode,
  requirement: string,
  message: string,
): void {
  issues.push({ code, requirement, message });
}

function describeAudioFormat(format: AudioFormat): string {
  return `${format.encoding}/${format.sampleRateHz}Hz/${format.channels}ch`;
}
