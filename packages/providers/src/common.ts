import WebSocket from "ws";

import { normalizeUnknownError, nowTimestamp } from "@tvic/core";
import type { NormalizedError, Timestamp } from "@tvic/core";

export { providerError, unknownErrorMessage } from "@tvic/core";

export interface ProviderClock {
  now(): Timestamp;
}

export class SystemProviderClock implements ProviderClock {
  now(): Timestamp {
    return nowTimestamp();
  }
}

/** Resolves once the socket is open; rejects with the raw socket error. */
export function openWebSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", (error) => reject(error));
  });
}

export interface NormalizeProviderErrorOptions {
  readonly code: string;
  readonly provider: string;
  readonly retriable?: boolean;
}

/** Pass an already-normalized error through unchanged; otherwise wrap it. */
export function normalizeProviderError(
  error: unknown,
  options: NormalizeProviderErrorOptions,
): NormalizedError {
  return normalizeUnknownError(error, {
    code: options.code,
    provider: options.provider,
    category: "provider",
    ...(options.retriable !== undefined ? { retriable: options.retriable } : {}),
  });
}

export function parseJsonObject(value: string): Readonly<Record<string, unknown>> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Readonly<Record<string, unknown>>)
      : null;
  } catch {
    return null;
  }
}
