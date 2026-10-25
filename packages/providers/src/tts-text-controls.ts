import {
  evaluateProviderCompatibility,
  normalizeTtsTextControls,
  TVIC_ERROR_CODES,
  TvicThrowableError,
  validationError,
} from "@tvic/core";
import type { Provider, TtsSessionOpenRequest, TtsTextControl } from "@tvic/core";

export function validateTtsTextControls<T extends TtsSessionOpenRequest>(
  provider: Provider,
  request: T,
): T & { readonly textControls: readonly TtsTextControl[] } {
  let textControls: readonly TtsTextControl[];
  try {
    textControls = normalizeTtsTextControls(request.textControls);
  } catch (error) {
    throw TvicThrowableError.from(
      validationError(TVIC_ERROR_CODES.providerInvalidRequest, safeMessage(error), {
        provider: provider.name,
      }),
    );
  }

  if (textControls.length > 0) {
    const compatibility = evaluateProviderCompatibility(provider, {
      kind: "tts",
      ...(request.model !== undefined ? { model: request.model } : {}),
      ttsTextControls: [...new Set(textControls.map((control) => control.type))],
    });
    if (!compatibility.compatible) {
      throw TvicThrowableError.from(
        validationError(
          TVIC_ERROR_CODES.providerInvalidRequest,
          compatibility.issues[0]?.message ?? "TTS text controls are unsupported",
          { provider: provider.name },
        ),
      );
    }
  }

  return { ...request, textControls };
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : "TTS text controls are invalid";
}
