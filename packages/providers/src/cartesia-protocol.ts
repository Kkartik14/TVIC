import { PROVIDER_NAMES } from "@tvic/core";

import { classifiedProviderError } from "./provider-error-classifier.js";

export type CartesiaMessage = Readonly<Record<string, unknown>> & {
  readonly type?: string;
  readonly data?: string;
  readonly done?: boolean;
  readonly context_id?: string;
  readonly message?: string;
  readonly title?: string;
  readonly error_code?: string;
  readonly status_code?: unknown;
  readonly flush_id?: number;
  readonly word_timestamps?: CartesiaAlignment;
  readonly phoneme_timestamps?: CartesiaAlignment;
};

export interface CartesiaAlignment {
  readonly words?: readonly unknown[];
  readonly phonemes?: readonly unknown[];
  readonly start?: readonly unknown[];
  readonly end?: readonly unknown[];
}

export function cartesiaProviderError(message: CartesiaMessage) {
  const input: {
    providerCode?: unknown;
    providerType?: unknown;
    status?: number;
    message?: unknown;
  } = {};
  const providerCode =
    typeof message.error_code === "string" && message.error_code.length <= 128
      ? message.error_code
      : undefined;
  if (providerCode !== undefined) input.providerCode = providerCode;
  if (message.type !== undefined) input.providerType = message.type;
  const status = integerStatus(message.status_code);
  if (status !== undefined) input.status = status;
  if (message.message !== undefined || message.title !== undefined) {
    input.message = message.message ?? message.title;
  }
  return classifiedProviderError(
    PROVIDER_NAMES.cartesia,
    "Cartesia rejected the synthesis request",
    input,
  );
}

function integerStatus(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

export function parseAlignment(
  alignment: CartesiaAlignment | undefined,
  tokenField: "words" | "phonemes",
): {
  readonly tokens: readonly string[];
  readonly startMs: readonly number[];
  readonly endMs: readonly number[];
} | null {
  const tokens = alignment?.[tokenField];
  const start = alignment?.start;
  const end = alignment?.end;
  if (
    !Array.isArray(tokens) ||
    !Array.isArray(start) ||
    !Array.isArray(end) ||
    tokens.length > 4096 ||
    tokens.length !== start.length ||
    tokens.length !== end.length ||
    !tokens.every((value): value is string => typeof value === "string") ||
    !start.every(
      (value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0,
    ) ||
    !end.every(
      (value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0,
    ) ||
    !start.every((value, index) => {
      const endValue = end[index];
      return typeof endValue === "number" && endValue >= value;
    })
  ) {
    return null;
  }
  const startMs = start.map((seconds) => seconds * 1000);
  const endMs = end.map((seconds) => seconds * 1000);
  if (!startMs.every(Number.isFinite) || !endMs.every(Number.isFinite)) {
    return null;
  }
  return { tokens, startMs, endMs };
}

export function isValidFlushId(value: number | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function decodeCartesiaAudio(value: string): Uint8Array {
  if (value.length > 1_398_104) {
    throw new Error("audio payload exceeds the size limit");
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new Error("invalid base64");
  }
  const bytes = new Uint8Array(Buffer.from(value, "base64"));
  const canonical = Buffer.from(bytes).toString("base64");
  if (bytes.byteLength === 0 || bytes.byteLength % 2 !== 0 || canonical !== value) {
    throw new Error("invalid pcm16le");
  }
  return bytes;
}
