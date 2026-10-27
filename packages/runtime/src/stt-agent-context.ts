import type { NormalizedError, SttStream } from "@tvic/core";
import {
  countUnicodeCodePoints,
  normalizeUnknownError,
  providerError,
  STT_ERROR_CODES,
  timeoutError,
  validationError,
} from "@tvic/core";
import { withPreservedTimeout } from "./async-control.js";
import { MAX_RUNTIME_STT_AGENT_CONTEXT_CHARACTERS } from "./pipeline-constants.js";

export const DEFAULT_STT_AGENT_CONTEXT_TIMEOUT_MS = 2_000;

const CONTEXT_LIMIT_MESSAGE = `STT agent context must not exceed ${MAX_RUNTIME_STT_AGENT_CONTEXT_CHARACTERS} characters`;

export interface SttAgentContextWaiter {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

export function createSttAgentContextWaiter(): SttAgentContextWaiter {
  let resolvePromise!: () => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

export function validateSttAgentContext(
  context: unknown,
  provider?: string,
): NormalizedError | undefined {
  if (
    typeof context === "string" &&
    countUnicodeCodePoints(context) <= MAX_RUNTIME_STT_AGENT_CONTEXT_CHARACTERS
  ) {
    return undefined;
  }
  return provider === undefined
    ? validationError(STT_ERROR_CODES.invalidRequest, CONTEXT_LIMIT_MESSAGE)
    : validationError(STT_ERROR_CODES.invalidRequest, CONTEXT_LIMIT_MESSAGE, { provider });
}

export function coalescePendingSttAgentContext<T, S extends T & { context: string }>(
  candidates: Iterable<T>,
  context: string,
  isCoalescible: (candidate: T) => candidate is S,
): S | undefined {
  for (const candidate of candidates) {
    if (!isCoalescible(candidate)) continue;
    candidate.context = context;
    return candidate;
  }
  return undefined;
}

export function missingSttAgentContextUpdateError(provider?: string): NormalizedError {
  return providerError(
    STT_ERROR_CODES.contextUpdateFailed,
    "The STT stream does not implement agent context updates",
    { ...(provider !== undefined ? { provider } : {}), retriable: false },
  );
}

export function sttAgentContextCancelledError(
  provider?: string,
  message = "STT agent context update cancelled",
): NormalizedError {
  return providerError(STT_ERROR_CODES.contextUpdateFailed, message, {
    ...(provider !== undefined ? { provider } : {}),
    retriable: true,
  });
}

export function sttAgentContextTimeoutError(timeoutMs: number, provider?: string): NormalizedError {
  return timeoutError(
    STT_ERROR_CODES.contextUpdateFailed,
    `STT agent context update timed out after ${timeoutMs}ms`,
    { ...(provider !== undefined ? { provider } : {}), retriable: true },
  );
}

export function normalizeSttAgentContextUpdateError(
  error: unknown,
  provider?: string,
): NormalizedError {
  return normalizeUnknownError(error, {
    code: STT_ERROR_CODES.contextUpdateFailed,
    category: "provider",
    ...(provider !== undefined ? { provider } : {}),
    retriable: false,
  });
}

export async function updateSttAgentContext(
  stream: SttStream,
  context: string,
  options: {
    readonly timeoutMs: number;
    readonly timeoutError?: NormalizedError;
    readonly provider?: string;
    readonly lifecycleSignal?: AbortSignal;
    readonly lifecycleAbortReason?: () => unknown;
    readonly callerSignal?: AbortSignal;
    readonly callerAbortReason?: () => unknown;
    readonly deferProviderCall?: boolean;
    readonly abortProviderOnFailure?: boolean;
    readonly onProviderAccepted?: () => void;
  },
): Promise<void> {
  const update = stream.updateAgentContext;
  if (typeof update !== "function") {
    throw missingSttAgentContextUpdateError(options.provider);
  }

  const timeout =
    options.timeoutError ??
    timeoutError(
      STT_ERROR_CODES.contextUpdateFailed,
      `STT agent context update timed out after ${options.timeoutMs}ms`,
      { retriable: true },
    );
  const updateAbort = new AbortController();
  let providerAccepted = false;
  const abortUpdate = (reason: unknown): void => {
    if (!updateAbort.signal.aborted) updateAbort.abort(reason);
  };
  const onLifecycleAbort = (): void => {
    abortUpdate(options.lifecycleAbortReason?.() ?? options.lifecycleSignal?.reason ?? timeout);
  };
  const onCallerAbort = (): void => {
    if (providerAccepted) return;
    abortUpdate(options.callerAbortReason?.() ?? options.callerSignal?.reason ?? timeout);
  };

  if (options.lifecycleSignal?.aborted) onLifecycleAbort();
  else options.lifecycleSignal?.addEventListener("abort", onLifecycleAbort, { once: true });
  if (options.callerSignal?.aborted) onCallerAbort();
  else options.callerSignal?.addEventListener("abort", onCallerAbort, { once: true });

  let providerWrite: Promise<void>;
  try {
    const write = options.deferProviderCall
      ? Promise.resolve().then(() => update.call(stream, context, { signal: updateAbort.signal }))
      : Promise.resolve(update.call(stream, context, { signal: updateAbort.signal }));
    providerWrite = write.then(() => {
      providerAccepted = true;
      options.callerSignal?.removeEventListener("abort", onCallerAbort);
      options.onProviderAccepted?.();
    });
  } catch (error) {
    options.lifecycleSignal?.removeEventListener("abort", onLifecycleAbort);
    options.callerSignal?.removeEventListener("abort", onCallerAbort);
    throw error;
  }

  try {
    await withPreservedTimeout(providerWrite, options.timeoutMs, timeout, updateAbort.signal);
  } catch (error) {
    if (
      options.abortProviderOnFailure !== false ||
      error === timeout ||
      options.lifecycleSignal?.aborted === true ||
      options.callerSignal?.aborted === true
    ) {
      abortUpdate(error);
    }
    throw error;
  } finally {
    options.lifecycleSignal?.removeEventListener("abort", onLifecycleAbort);
    options.callerSignal?.removeEventListener("abort", onCallerAbort);
  }
}

export function boundSttAgentContext(context: string): string {
  let start = context.length;
  let count = 0;
  while (start > 0 && count < MAX_RUNTIME_STT_AGENT_CONTEXT_CHARACTERS) {
    start -= 1;
    const codeUnit = context.charCodeAt(start);
    if (
      codeUnit >= 0xdc00 &&
      codeUnit <= 0xdfff &&
      start > 0 &&
      context.charCodeAt(start - 1) >= 0xd800 &&
      context.charCodeAt(start - 1) <= 0xdbff
    ) {
      start -= 1;
    }
    count += 1;
  }
  return start === 0 ? context : context.slice(start);
}
