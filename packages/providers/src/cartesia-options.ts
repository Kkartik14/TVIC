import {
  PROVIDER_CAPABILITY_FEATURES,
  PROVIDER_NAMES,
  TVIC_ERROR_CODES,
  TvicThrowableError,
  resolveProviderCapability,
  validationError,
} from "@tvic/core";
import type { ProviderCapabilitySnapshot } from "@tvic/core";
import { PROVIDER_CATALOG } from "./catalog.js";

export interface CartesiaGenerationConfig {
  readonly volume?: number;

  readonly speed?: number;

  readonly emotion?: string;
}

export function assertCartesiaOptions(
  generationConfig: CartesiaGenerationConfig | undefined,
  maxBufferDelayMs: number,
): void {
  if (generationConfig?.volume !== undefined && !Number.isFinite(generationConfig.volume)) {
    throw TvicThrowableError.from(
      validationError(TVIC_ERROR_CODES.providerInvalidRequest, "Cartesia volume must be finite", {
        provider: PROVIDER_NAMES.cartesia,
      }),
    );
  }
  if (generationConfig?.speed !== undefined) {
    assertCartesiaSpeed(generationConfig.speed);
  }
  if (
    generationConfig?.emotion !== undefined &&
    (generationConfig.emotion.length === 0 || generationConfig.emotion.length > 128)
  ) {
    throw TvicThrowableError.from(
      validationError(
        TVIC_ERROR_CODES.providerInvalidRequest,
        "Cartesia emotion must contain between 1 and 128 characters",
        { provider: PROVIDER_NAMES.cartesia },
      ),
    );
  }
  if (!Number.isInteger(maxBufferDelayMs) || maxBufferDelayMs < 0 || maxBufferDelayMs > 5000) {
    throw TvicThrowableError.from(
      validationError(
        TVIC_ERROR_CODES.providerInvalidRequest,
        "Cartesia maxBufferDelayMs must be an integer from 0 through 5000",
        { provider: PROVIDER_NAMES.cartesia, metadata: { maxBufferDelayMs } },
      ),
    );
  }
}

export function assertCartesiaSpeed(speed: number | undefined): void {
  if (speed === undefined) return;
  if (!Number.isFinite(speed) || speed < 0.6 || speed > 1.5) {
    throw TvicThrowableError.from(
      validationError(
        TVIC_ERROR_CODES.providerInvalidRequest,
        "Cartesia speed must be between 0.6 and 1.5",
        { provider: PROVIDER_NAMES.cartesia, metadata: { speed } },
      ),
    );
  }
}

export function assertCartesiaSpeedVoiceCapability(
  snapshots: readonly ProviderCapabilitySnapshot[] | undefined,
  voice: string,
  speed: number | undefined,
): void {
  if (speed === undefined) return;
  const resolution = resolveProviderCapability(snapshots ?? [], {
    provider: PROVIDER_NAMES.cartesia,
    feature: PROVIDER_CAPABILITY_FEATURES.ttsVoiceIsPro,
    scope: "voice",
    voice,
  });
  if (resolution.status === "supported" && resolution.value === false) return;

  const state =
    resolution.status === "unknown"
      ? resolution.reason
      : resolution.status === "supported"
        ? "professional_voice"
        : "unsupported";
  throw TvicThrowableError.from(
    validationError(
      TVIC_ERROR_CODES.providerInvalidRequest,
      `Cartesia speed requires a verified non-professional voice, but its capability snapshot is ${state}`,
      { provider: PROVIDER_NAMES.cartesia },
    ),
  );
}

export function assertCartesiaTtsSettings(
  modelId: string,
  normalization: string | undefined,
  pronunciationDictId: string | undefined,
): void {
  if (normalization !== undefined) {
    try {
      if (normalization !== "auto" && normalization !== "off") {
        Intl.getCanonicalLocales(normalization);
      }
    } catch {
      throw cartesiaSettingError("Cartesia normalization must be auto, off, or a language tag");
    }
    if (!PROVIDER_CATALOG.cartesia.normalizationModels?.some((model) => model === modelId)) {
      throw cartesiaSettingError(`Cartesia normalization is unsupported for model ${modelId}`);
    }
  }
  if (pronunciationDictId !== undefined) {
    if (
      typeof pronunciationDictId !== "string" ||
      pronunciationDictId.trim().length === 0 ||
      pronunciationDictId.length > 256 ||
      /[\u0000-\u001f\u007f]/u.test(pronunciationDictId)
    ) {
      throw cartesiaSettingError("Cartesia pronunciation dictionary ID is invalid");
    }
    if (
      !PROVIDER_CATALOG.cartesia.pronunciationDictionaryModels?.some((model) => model === modelId)
    ) {
      throw cartesiaSettingError(
        `Cartesia pronunciation dictionaries are unsupported for model ${modelId}`,
      );
    }
  }
}

function cartesiaSettingError(message: string): TvicThrowableError {
  return TvicThrowableError.from(
    validationError(TVIC_ERROR_CODES.providerInvalidRequest, message, {
      provider: PROVIDER_NAMES.cartesia,
    }),
  );
}

export function cartesiaGenerationConfig(
  configured: CartesiaGenerationConfig | undefined,
  requestSpeed: number | undefined,
): Readonly<Record<string, unknown>> {
  const generationConfig = {
    ...(configured ?? {}),
    ...(requestSpeed !== undefined ? { speed: requestSpeed } : {}),
  };
  return Object.keys(generationConfig).length > 0 ? { generation_config: generationConfig } : {};
}
