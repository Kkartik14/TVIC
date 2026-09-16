import { providerError, TVIC_ERROR_CODES, TvicThrowableError } from "@tvic/core";

export type RuntimeLimitUnit = "bytes" | "events" | "calls";

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function runtimeResourceLimitError(
  resource: string,
  unit: RuntimeLimitUnit,
  limit: number,
): TvicThrowableError {
  return TvicThrowableError.from(
    providerError(
      TVIC_ERROR_CODES.providerStreamBufferOverflow,
      `Runtime ${resource} exceeded its ${limit} ${unit} limit`,
      {
        provider: "tvic-runtime",
        retriable: false,
        metadata: { resource, unit, limit },
      },
    ),
  );
}
