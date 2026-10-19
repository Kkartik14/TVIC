import type { RuntimePipelineObservationInput } from "@tvic/core";

// Keeps the pipeline writer off the public Runtime interface.
type RuntimeObservationWriter = (observation: RuntimePipelineObservationInput) => void;

const writers = new WeakMap<object, RuntimeObservationWriter>();

export function registerRuntimeObservationWriter(
  runtime: object,
  writer: RuntimeObservationWriter,
): void {
  writers.set(runtime, writer);
}

export function recordRuntimePipelineObservation(
  runtime: object,
  observation: RuntimePipelineObservationInput,
): void {
  writers.get(runtime)?.(observation);
}
