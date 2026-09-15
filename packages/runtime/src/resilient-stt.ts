import type { SpeechToTextProvider, SttOpenRequest, SttStream } from "@tvic/core";
import { validationError, TvicThrowableError } from "@tvic/core";
import { cancelWithTimeout } from "./async-control.js";
import { CANCELLATION_TIMEOUT_MS } from "./pipeline-constants.js";
import { ResilientSttStream } from "./resilient-stt-stream.js";
export { STT_RECOVERY_CONTROL, getSttRecoveryControl } from "./resilient-stt-control.js";
export type { SttRecoveryControl, SttRecoveryState } from "./resilient-stt-control.js";
import {
  normalizeGenerationError,
  resolveOptions,
  sameOptions,
  type ResolvedSttReconnectOptions,
} from "./resilient-stt-policy.js";

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
  readonly maxBufferedBytes?: number;
  readonly maxBufferedCommands?: number;
  /** Bounds provider acceptance of one audio command in each generation. */
  readonly sendTimeoutMs?: number;
  readonly commitTimeoutMs?: number;
}

const STT_RECONNECT_BRAND = Symbol("tvic.stt.reconnect");

interface ReconnectBrand {
  readonly options: ResolvedSttReconnectOptions;
}

interface ReconnectBrandedProvider extends SpeechToTextProvider {
  readonly [STT_RECONNECT_BRAND]?: ReconnectBrand;
}

/**
 * Wraps one STT provider with bounded, best-effort reconnect and replay policy.
 * The wrapper is deliberately runtime-owned: adapters only need to expose honest
 * transport and timestamp semantics.
 */
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
    if (provider.region !== undefined) {
      this.region = provider.region;
    }
    if (provider.metadata !== undefined) {
      this.metadata = provider.metadata;
    }
  }

  async open(request: SttOpenRequest): Promise<SttStream> {
    let stream: SttStream | undefined;
    try {
      stream = await this.#provider.open(request);
      if (!stream.timestampOrigin) {
        await closeStreamBounded(stream);
        stream = undefined;
        throw TvicThrowableError.from(
          validationError(
            "stt.reconnect.timestamp_origin_unsupported",
            `${this.#provider.name} does not declare a reconnect-safe STT timestamp origin`,
            { provider: this.#provider.name },
          ),
        );
      }
      const wrapped = new ResilientSttStream(this.#provider, request, stream, this.#options);
      stream = undefined;
      return wrapped;
    } catch (error) {
      if (stream) await closeStreamBounded(stream);
      throw TvicThrowableError.from(normalizeGenerationError(error, this.#provider.name));
    }
  }
}

async function closeStreamBounded(stream: SttStream): Promise<void> {
  await cancelWithTimeout(() => stream.close(), CANCELLATION_TIMEOUT_MS).catch(() => undefined);
}
