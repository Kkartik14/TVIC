import type { TraceEvent, TraceExporter, TraceRedactor, TraceStore } from "@tvic/core";

export interface EmitTraceEventOptions {
  readonly store: TraceStore;
  readonly handlers?: Iterable<(event: TraceEvent) => void>;
  readonly exportersFor?: (event: TraceEvent) => Promise<readonly TraceExporter[]>;
  readonly redactor?: TraceRedactor;
  readonly stamp?: (event: TraceEvent) => Promise<TraceEvent>;
}

export async function emitTraceEvent(
  event: TraceEvent,
  options: EmitTraceEventOptions,
): Promise<void> {
  const stamped = options.stamp ? await options.stamp(event) : event;
  const redacted = options.redactor ? options.redactor(stamped) : stamped;
  if (!redacted) {
    return;
  }

  await options.store.append(redacted);
  for (const handler of options.handlers ?? []) {
    handler(redacted);
  }

  const exporters = options.exportersFor ? await options.exportersFor(redacted) : [];
  await Promise.all(exporters.map((exporter) => exporter.export([redacted])));
}
