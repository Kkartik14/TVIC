import type { Provider } from "../provider.js";
import type { TraceEvent } from "../trace.js";

export interface TraceExporter extends Provider {
  readonly kind: "trace_exporter";
  /**
   * Accepts events for export. The returned promise resolves once the events are
   * **accepted/enqueued in order**, NOT once they are durably written — disk/network
   * latency stays off the realtime trace path. Callers MUST NOT assume durability from
   * `export()` alone; use `flush()` or `close()` to await durable persistence.
   * Per-event write failures are surfaced by the exporter (e.g. an artifact writer's
   * `writeFailures` count), not by rejecting `export()`.
   */
  export(events: readonly TraceEvent[]): Promise<void>;
  /** Resolves once all events accepted so far are durably written. */
  flush(): Promise<void>;
  /** Drains and durably writes all pending events, then releases resources. */
  close(): Promise<void>;
}
