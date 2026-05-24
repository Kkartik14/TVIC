import type { TraceEvent, TraceExporter, TraceRedactor, TraceStore } from "@tvic/core";

export interface EmitTraceEventOptions {
  readonly store: TraceStore;
  readonly handlers?: Iterable<(event: TraceEvent) => void>;
  readonly exportersFor?: (event: TraceEvent) => Promise<readonly TraceExporter[]>;
  readonly redactor?: TraceRedactor;
  readonly stamp?: (event: TraceEvent) => Promise<TraceEvent>;
  /** Reports a failure in any sink. Observability never throws into the caller. */
  readonly onError?: (error: unknown) => void;
}

/**
 * Emits a single trace event to the store, live handlers, and exporters. The store and
 * every exporter are INDEPENDENT failure domains (a broken/throwing sink is reported via
 * `onError`, never propagated), and every sink is fully awaited before this resolves.
 *
 * There is deliberately NO per-sink timeout here: abandoning a slow sink mid-write would
 * let a later event's write land before the abandoned one completes, silently reordering
 * that sink's stream. Ordering across events is the caller's responsibility — await this
 * sequentially, or keep a per-sink queue. A caller that needs to bound a hanging sink
 * must wrap the call, or use exporters that are internally serialized and cancellable.
 */
export async function emitTraceEvent(
  event: TraceEvent,
  options: EmitTraceEventOptions,
): Promise<void> {
  const report = options.onError ?? (() => undefined);

  let prepared: TraceEvent;
  try {
    const stamped = options.stamp ? await options.stamp(event) : event;
    const redacted = options.redactor ? options.redactor(stamped) : stamped;
    if (!redacted) {
      return;
    }
    prepared = redacted;
  } catch (error) {
    report(error);
    return;
  }

  // Synchronous observers run first and are isolated.
  for (const handler of options.handlers ?? []) {
    try {
      handler(prepared);
    } catch (error) {
      report(error);
    }
  }

  let exporters: readonly TraceExporter[] = [];
  try {
    exporters = options.exportersFor ? await options.exportersFor(prepared) : [];
  } catch (error) {
    report(error);
  }

  const dispatch = async (run: () => Promise<void>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      report(error);
    }
  };

  // Within one event the store and exporters are independent failure domains, dispatched
  // concurrently; cross-event FIFO ordering is the caller's responsibility.
  const sinks: Promise<void>[] = [dispatch(() => options.store.append(prepared))];
  for (const exporter of exporters) {
    sinks.push(dispatch(() => exporter.export([prepared])));
  }

  await Promise.all(sinks);
}
