import type {
  SpeechToTextProvider,
  SttLanguagePolicy,
  SttOpenRequest,
  SttStream,
} from "@tvic/core";
import { validationError, TvicThrowableError } from "@tvic/core";
import { ResilientSttStream } from "./resilient-stt-stream.js";
export { STT_RECOVERY_CONTROL, getSttRecoveryControl } from "./resilient-stt-control.js";
export type { SttRecoveryControl, SttRecoveryState } from "./resilient-stt-control.js";
import {
  normalizeGenerationError,
  resolveStreamOptions,
  resolveOptions,
  sameOptions,
  type ResolvedSttReconnectOptions,
} from "./resilient-stt-policy.js";
import { closeSttProviderStreamBounded as closeProviderStream } from "./stt-cleanup.js";

export interface SttReconnectOptions {
  readonly maxAttempts?: number;
  readonly connectTimeoutMs?: number;
  readonly maxRecoveryDurationMs?: number;
  readonly initialBackoffMs?: number;
  readonly maxBackoffMs?: number;
  readonly jitter?: boolean;
  readonly stableUptimeMs?: number;
  readonly maxQuickFailures?: number;
  readonly uncertainWindowMs?: number;
  /**
   * Maximum bytes retained for replay and pending audio. The default is derived
   * from the requested audio format and `2 * uncertainWindowMs + maxRecoveryDurationMs`
   * plus one input frame of headroom, up to a 16 MiB default ceiling. Set this
   * explicitly for a smaller fail-fast budget or when that ceiling is insufficient.
   */
  readonly maxBufferedBytes?: number;
  /**
   * Maximum journal entries. The default is derived from `2 * uncertainWindowMs +
   * maxRecoveryDurationMs`, the format's frameDurationMs (or an assumed 10 ms
   * when unspecified), and control-command headroom, up to an 8,192-entry ceiling.
   * Shorter actual frames can reach this bound before the time windows expire.
   */
  readonly maxBufferedCommands?: number;
  readonly sendTimeoutMs?: number;
  /** Deadline for context updates; defaults to 2 seconds independently of sendTimeoutMs. */
  readonly contextUpdateTimeoutMs?: number;
  readonly commitTimeoutMs?: number;
  readonly audioWriteTimeoutMs?: number;
  /**
   * Maximum time allowed for the full graceful journal drain, including context writes.
   * This may be shorter than contextUpdateTimeoutMs; close then settles pending
   * commands when the overall shutdown deadline expires.
   */
  readonly closeTimeoutMs?: number;
}

const STT_RECONNECT_BRAND = Symbol("tvic.stt.reconnect");

interface ReconnectBrand {
  readonly options: ResolvedSttReconnectOptions;
}

interface ReconnectBrandedProvider extends SpeechToTextProvider {
  readonly [STT_RECONNECT_BRAND]?: ReconnectBrand;
}

export function withSttReconnect(
  provider: SpeechToTextProvider,
  options: SttReconnectOptions = {},
): SpeechToTextProvider {
  const resolved = resolveOptions(options);
  const branded = (provider as ReconnectBrandedProvider)[STT_RECONNECT_BRAND];
  if (branded) {
    if (!sameOptions(branded.options, resolved)) {
      throw TvicThrowableError.from(
        validationError(
          "stt.reconnect.conflicting_policy",
          "The STT provider is already wrapped with a different reconnect policy",
        ),
      );
    }
    return provider;
  }

  const wrapped = new ResilientSttProvider(provider, resolved);
  Object.defineProperty(wrapped, STT_RECONNECT_BRAND, {
    configurable: false,
    enumerable: false,
    value: { options: resolved } satisfies ReconnectBrand,
    writable: false,
  });
  return wrapped;
}

class ResilientSttProvider implements SpeechToTextProvider {
  readonly name: string;
  readonly kind = "stt" as const;
  readonly version: string;
  readonly capabilities: SpeechToTextProvider["capabilities"];
  readonly usageAccounting?: NonNullable<SpeechToTextProvider["usageAccounting"]>;
  readonly region?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly #provider: SpeechToTextProvider;
  readonly #options: ResolvedSttReconnectOptions;

  constructor(provider: SpeechToTextProvider, options: ResolvedSttReconnectOptions) {
    this.#provider = provider;
    this.#options = options;
    this.name = provider.name;
    this.version = provider.version;
    this.capabilities = provider.capabilities;
    if (provider.usageAccounting !== undefined) {
      this.usageAccounting = provider.usageAccounting;
    }
    if (provider.region !== undefined) {
      this.region = provider.region;
    }
    if (provider.metadata !== undefined) {
      this.metadata = provider.metadata;
    }
  }

  supportsSttLanguagePolicy(policy: SttLanguagePolicy, model?: string): boolean {
    return this.#provider.supportsSttLanguagePolicy?.(policy, model) ?? false;
  }

  supportsSttVocabulary(
    vocabulary: readonly string[],
    model?: string,
    allowUnknownModel?: boolean,
  ): boolean {
    return this.#provider.supportsSttVocabulary?.(vocabulary, model, allowUnknownModel) ?? false;
  }

  supportsSttAgentContext(model?: string): boolean {
    return this.#provider.supportsSttAgentContext?.(model) ?? false;
  }

  async open(request: SttOpenRequest): Promise<SttStream> {
    const streamOptions = resolveStreamOptions(this.#options, request.format);
    let stream: SttStream | undefined;
    try {
      stream = await this.#provider.open(request);
      if (!stream.timestampOrigin) {
        await closeProviderStream(stream, this.#provider.name, this.#options.closeTimeoutMs).catch(
          () => undefined,
        );
        stream = undefined;
        throw TvicThrowableError.from(
          validationError(
            "stt.reconnect.timestamp_origin_unsupported",
            `${this.#provider.name} does not declare a reconnect-safe STT timestamp origin`,
            { provider: this.#provider.name },
          ),
        );
      }
      const wrapped = new ResilientSttStream(this.#provider, request, stream, streamOptions);
      stream = undefined;
      return wrapped;
    } catch (error) {
      await closeProviderStream(stream, this.#provider.name, this.#options.closeTimeoutMs).catch(
        () => undefined,
      );
      throw TvicThrowableError.from(normalizeGenerationError(error, this.#provider.name));
    }
  }
}
