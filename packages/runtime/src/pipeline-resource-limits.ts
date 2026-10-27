import { providerError, TVIC_ERROR_CODES, TvicThrowableError } from "@tvic/core";

export type RuntimeLimitUnit = "bytes" | "events" | "calls";

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function utf8ByteLengthWithinLimit(value: string, limitBytes: number): number | undefined {
  let byteLength = 0;
  for (const character of value) {
    byteLength += utf8CodePointByteLength(character.codePointAt(0) ?? 0);
    if (byteLength > limitBytes) return undefined;
  }
  return byteLength;
}

export function utf8CodePointByteLength(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
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
