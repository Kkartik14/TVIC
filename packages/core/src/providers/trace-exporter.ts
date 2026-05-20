import type { Provider } from "../provider.js";
import type { TraceEvent } from "../trace.js";

export interface TraceExporter extends Provider {
  readonly kind: "trace_exporter";
  export(events: readonly TraceEvent[]): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
}
