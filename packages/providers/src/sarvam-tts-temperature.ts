import { ADAPTER_DEFAULTS } from "./catalog.js";
import { isSarvamTtsV4FlashModel } from "./sarvam-tts-model.js";
import { assertSarvamTtsNumber } from "./sarvam-tts-validation.js";

/**
 * Temperature sent on every Sarvam route: Bulbul v4 Flash sends only what the caller
 * configured (no default); other models fall back to the adapter default.
 */
export function resolveSarvamTtsTemperature(
  model: string,
  configured: number | undefined,
): number | undefined {
  const temperature = isSarvamTtsV4FlashModel(model)
    ? configured
    : (configured ?? ADAPTER_DEFAULTS.sarvamTts.temperature);
  if (temperature !== undefined) assertSarvamTtsNumber("temperature", temperature, 0.01, 1);
  return temperature;
}
