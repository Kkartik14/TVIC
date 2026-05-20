import { appendFile } from "node:fs/promises";

import type {
  ProviderCapabilities,
  TraceEvent,
  TraceEventType,
  TraceExporter,
  TraceQuery,
  TraceStore,
} from "@tvic/core";

function isWithinRange(event: TraceEvent, query: TraceQuery): boolean {
  if (query.sessionId && event.sessionId !== query.sessionId) {
    return false;
  }

  if (query.traceId && event.traceId !== query.traceId) {
    return false;
  }

  if (query.types && !query.types.includes(event.type)) {
    return false;
  }

  if (query.since && event.timestamp < query.since) {
    return false;
  }

  if (query.until && event.timestamp > query.until) {
    return false;
  }

  return true;
}

export class InMemoryTraceStore implements TraceStore {
  readonly #events: TraceEvent[] = [];
  #closed = false;

  constructor(initialEvents: readonly TraceEvent[] = []) {
    this.#events.push(...initialEvents);
  }

  async append(event: TraceEvent): Promise<void> {
    this.#assertOpen();
    this.#events.push(event);
  }

  async query(query: TraceQuery): Promise<readonly TraceEvent[]> {
    this.#assertOpen();
    const events = this.#events.filter((event) => isWithinRange(event, query));
    return typeof query.limit === "number" ? events.slice(0, query.limit) : events;
  }

  async close(): Promise<void> {
    this.#closed = true;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error("TraceStore is closed");
    }
  }
}

export function createInMemoryTraceStore(
  initialEvents: readonly TraceEvent[] = [],
): InMemoryTraceStore {
  return new InMemoryTraceStore(initialEvents);
}

export interface JsonlTraceExporterOptions {
  readonly path: string;
  readonly name?: string;
  readonly version?: string;
}

const TRACE_EXPORTER_CAPABILITIES: ProviderCapabilities = {
  streaming: false,
  interruption: false,
};

export class JsonlTraceExporter implements TraceExporter {
  readonly name: string;
  readonly kind = "trace_exporter";
  readonly version: string;
  readonly capabilities = TRACE_EXPORTER_CAPABILITIES;

  readonly #path: string;
  #closed = false;

  constructor(options: JsonlTraceExporterOptions) {
    this.name = options.name ?? "jsonl-trace-exporter";
    this.version = options.version ?? "0.1.0";
    this.#path = options.path;
  }

  async export(events: readonly TraceEvent[]): Promise<void> {
    if (this.#closed || events.length === 0) {
      return;
    }

    const body = events.map((event) => JSON.stringify(event)).join("\n");
    await appendFile(this.#path, `${body}\n`, "utf8");
  }

  async flush(): Promise<void> {
    return;
  }

  async close(): Promise<void> {
    this.#closed = true;
  }
}

export function traceTypes(events: readonly TraceEvent[]): readonly TraceEventType[] {
  return events.map((event) => event.type);
}

export type { TraceEvent, TraceEventType, TraceQuery, TraceStore };
