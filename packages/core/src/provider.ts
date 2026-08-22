import type { AudioFormat } from "./audio.js";

export type ProviderKind = "telephony" | "stt" | "tts" | "llm" | "storage";

/** Transports TVIC 1.0 executes. gRPC/http2 arrive with the SDK-based STT wave. */
export type ProviderTransport = "http" | "sse" | "websocket";

export type TurnDetectionMode = "provider" | "stt_endpointing" | "vad" | "semantic" | "manual";

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

/**
 * Capabilities describe one configured adapter/deployment, not every feature sold by
 * the provider. Mutable catalog facts may be omitted until they are verified.
 */
export interface ProviderCapabilities {
  readonly streaming: ProviderStreamingCapabilities;
  readonly cancellation: ProviderCancellationCapabilities;
  readonly transports: readonly ProviderTransport[];
  readonly audio?: ProviderAudioCapabilities;
  readonly languages?: readonly string[];
  readonly models?: readonly string[];
  readonly voices?: readonly string[];
  readonly turnDetection?: readonly TurnDetectionMode[];
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
  readonly cancellation?: RequiredProviderCapabilities<ProviderCancellationCapabilities>;
  readonly transport?: ProviderTransport;
  readonly inputFormat?: AudioFormat;
  readonly outputFormat?: AudioFormat;
  readonly language?: string;
  readonly model?: string;
  readonly voice?: string;
  readonly turnDetection?: TurnDetectionMode;
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
  | "cancellation.unsupported"
  | "transport.unsupported"
  | "audio.input_unsupported"
  | "audio.output_unsupported"
  | "language.unsupported"
  | "model.unsupported"
  | "voice.unsupported"
  | "turn_detection.unsupported"
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

  checkMember(issues, provider.name, "language", requirements.language, capabilities.languages);
  checkMember(issues, provider.name, "model", requirements.model, capabilities.models);
  checkMember(issues, provider.name, "voice", requirements.voice, capabilities.voices);
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
  requirement: "language" | "model" | "voice" | "turn_detection" | "region" | "data_policy",
  required: string | undefined,
  available: readonly string[] | undefined,
): void {
  if (!required || available?.includes(required)) {
    return;
  }
  const codeByRequirement = {
    language: "language.unsupported",
    model: "model.unsupported",
    voice: "voice.unsupported",
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
