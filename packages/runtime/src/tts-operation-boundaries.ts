import type { TtsTextOperation } from "@tvic/core";

export const TTS_BOUNDARY_NONE = 0;
export const TTS_BOUNDARY_COMPLETE = 1;
export const TTS_BOUNDARY_INCOMPLETE = 2;

interface MatchOutput {
  readonly length: number;
}

interface MatchNode {
  readonly transitions: Map<number, number>;
  readonly outputs: MatchOutput[];
  failure: number;
  properPrefix: boolean;
  hasProperPrefixSuffix: boolean;
}

export class TtsOperationBoundaryMatcher {
  readonly #nodes: readonly MatchNode[];

  constructor(operations: readonly TtsTextOperation[]) {
    this.#nodes = buildMatcherNodes(operations);
  }

  classify(text: string, boundaries: readonly number[]): Uint8Array {
    const result = new Uint8Array(boundaries.length);
    if (this.#nodes.length === 1 || boundaries.length === 0) return result;

    const completedRanges = new Int32Array(boundaries.length + 1);
    let state = 0;
    let nextBoundary = 0;
    for (let index = 0; index < text.length; index += 1) {
      const character = text.charCodeAt(index);
      state = transition(this.#nodes, state, character);
      const end = index + 1;
      while (boundaries[nextBoundary] === end) {
        if (this.#nodes[state]?.hasProperPrefixSuffix) {
          result[nextBoundary] = TTS_BOUNDARY_INCOMPLETE;
        }
        nextBoundary += 1;
      }
      for (const output of this.#nodes[state]?.outputs ?? []) {
        const start = end - output.length;
        const firstBoundary = upperBound(boundaries, start);
        const afterLastBoundary = lowerBound(boundaries, end);
        completedRanges[firstBoundary] = (completedRanges[firstBoundary] ?? 0) + 1;
        completedRanges[afterLastBoundary] = (completedRanges[afterLastBoundary] ?? 0) - 1;
      }
    }

    let activeRanges = 0;
    for (let index = 0; index < boundaries.length; index += 1) {
      activeRanges += completedRanges[index] ?? 0;
      if (activeRanges > 0) result[index] = TTS_BOUNDARY_COMPLETE;
    }

    return result;
  }
}

function buildMatcherNodes(operations: readonly TtsTextOperation[]): MatchNode[] {
  const nodes: MatchNode[] = [createNode()];
  const matches = new Set(operations.map((operation) => operation.match));

  for (const match of matches) {
    let nodeIndex = 0;
    for (let index = 0; index < match.length; index += 1) {
      const character = match.charCodeAt(index);
      const node = nodes[nodeIndex];
      if (node === undefined) throw new Error("TTS operation matcher node is missing");
      let childIndex = node.transitions.get(character);
      if (childIndex === undefined) {
        childIndex = nodes.length;
        node.transitions.set(character, childIndex);
        nodes.push(createNode());
      }
      nodeIndex = childIndex;
      if (index < match.length - 1) {
        const prefixNode = nodes[nodeIndex];
        if (prefixNode === undefined) throw new Error("TTS operation matcher node is missing");
        prefixNode.properPrefix = true;
      }
    }
    const terminal = nodes[nodeIndex];
    if (terminal === undefined) throw new Error("TTS operation matcher node is missing");
    terminal.outputs.push({ length: match.length });
  }

  const queue: number[] = [];
  for (const childIndex of nodes[0]?.transitions.values() ?? []) {
    const child = nodes[childIndex];
    if (child === undefined) continue;
    child.failure = 0;
    child.hasProperPrefixSuffix = child.properPrefix;
    queue.push(childIndex);
  }

  for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
    const nodeIndex = queue[queueIndex];
    const node = nodeIndex === undefined ? undefined : nodes[nodeIndex];
    if (node === undefined) continue;
    for (const [character, childIndex] of node.transitions) {
      let failure = node.failure;
      while (failure !== 0 && !nodes[failure]?.transitions.has(character)) {
        failure = nodes[failure]?.failure ?? 0;
      }
      const candidate = nodes[failure]?.transitions.get(character);
      const child = nodes[childIndex];
      if (child === undefined) continue;
      child.failure = candidate !== undefined && candidate !== childIndex ? candidate : 0;
      const failureNode = nodes[child.failure];
      if (failureNode !== undefined) {
        child.outputs.push(...failureNode.outputs);
        child.hasProperPrefixSuffix = child.properPrefix || failureNode.hasProperPrefixSuffix;
      }
      queue.push(childIndex);
    }
  }

  return nodes;
}

function createNode(): MatchNode {
  return {
    transitions: new Map(),
    outputs: [],
    failure: 0,
    properPrefix: false,
    hasProperPrefixSuffix: false,
  };
}

function transition(nodes: readonly MatchNode[], current: number, character: number): number {
  let state = current;
  while (state !== 0 && !nodes[state]?.transitions.has(character)) {
    state = nodes[state]?.failure ?? 0;
  }
  return nodes[state]?.transitions.get(character) ?? 0;
}

function upperBound(values: readonly number[], value: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const candidate = values[middle];
    if (candidate !== undefined && candidate <= value) low = middle + 1;
    else high = middle;
  }
  return low;
}

function lowerBound(values: readonly number[], value: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const candidate = values[middle];
    if (candidate !== undefined && candidate < value) low = middle + 1;
    else high = middle;
  }
  return low;
}
