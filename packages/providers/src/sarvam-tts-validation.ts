import {
  PCM16_16K_MONO,
  PROVIDER_NAMES,
  TVIC_ERROR_CODES,
  sameAudioFormat,
  validationError,
  TvicThrowableError,
} from "@tvic/core";
import type { AudioFormat, ProviderTtsSpeedRange } from "@tvic/core";
import { PROVIDER_CATALOG } from "./catalog.js";
import { SARVAM_TTS_V4_FLASH_MODEL } from "./sarvam-tts-v4-voices.js";

export const SARVAM_TTS_SPEED_RANGE = Object.freeze({ min: 0.5, max: 2 });

/** Bulbul v4 Flash rejects `temperature` on the WebSocket route; the HTTP routes accept it. */
export function supportsSarvamTtsWebSocketTemperatureModel(
  model: string,
  temperature: number | undefined,
): boolean {
  return model !== SARVAM_TTS_V4_FLASH_MODEL || temperature === undefined;
}

export function assertSarvamTtsWebSocketTemperatureModel(
  model: string,
  temperature: number | undefined,
): void {
  if (supportsSarvamTtsWebSocketTemperatureModel(model, temperature)) return;
  throw sarvamTtsValidationError("Sarvam Bulbul v4 Flash does not support temperature", {
    model,
    temperature,
  });
}

export function sarvamTtsSpeedRanges(): readonly ProviderTtsSpeedRange[] {
  return Object.freeze(
    PROVIDER_CATALOG.sarvamTts.models.map((model) =>
      Object.freeze({ model, ...SARVAM_TTS_SPEED_RANGE }),
    ),
  );
}

export function sarvamTtsValidationError(
  message: string,
  metadata?: Readonly<Record<string, unknown>>,
): TvicThrowableError {
  const options =
    metadata === undefined
      ? { provider: PROVIDER_NAMES.sarvamTts }
      : { provider: PROVIDER_NAMES.sarvamTts, metadata };
  return TvicThrowableError.from(
    validationError(TVIC_ERROR_CODES.providerInvalidRequest, message, options),
  );
}

export function assertSarvamTtsFormat(
  format: AudioFormat,
  message = "Sarvam TTS requires 16kHz PCM16 mono output",
): void {
  if (!sameAudioFormat(format, PCM16_16K_MONO)) {
    throw sarvamTtsValidationError(message, { format });
  }
}

export function assertSarvamTtsText(value: unknown): asserts value is string {
  if (typeof value !== "string") {
    throw sarvamTtsValidationError("Sarvam TTS text must be a string");
  }
}

export function assertSarvamTtsNumber(
  name: string,
  value: unknown,
  min: number,
  max: number,
): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw sarvamTtsValidationError(`Sarvam Bulbul ${name} must be between ${min} and ${max}`, {
      [name]: value,
    });
  }
}

export function assertSarvamTtsInteger(
  name: string,
  value: unknown,
  min: number,
  max: number,
): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw sarvamTtsValidationError(
      `Sarvam TTS ${name} must be an integer between ${min} and ${max}`,
      { [name]: value },
    );
  }
}
