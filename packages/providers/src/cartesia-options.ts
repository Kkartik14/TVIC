import { TVIC_ERROR_CODES, PROVIDER_NAMES, TvicThrowableError, validationError } from "@tvic/core";

export interface CartesiaGenerationConfig {
  /** Relative output volume; Cartesia interprets the value for the selected model. */
  readonly volume?: number;
  /** Relative speaking speed; a request-level speed overrides this value. */
  readonly speed?: number;
  /** Optional Sonic emotion/style control. */
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
  if (!Number.isFinite(speed) || speed <= 0) {
    throw TvicThrowableError.from(
      validationError(
        TVIC_ERROR_CODES.providerInvalidRequest,
        "Cartesia speed must be a finite positive number",
        { provider: PROVIDER_NAMES.cartesia, metadata: { speed } },
      ),
    );
  }
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
