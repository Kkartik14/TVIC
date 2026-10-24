import type { TtsTextOperation } from "@tvic/core";

export const TTS_BOUNDARY_NONE = 0;
export const TTS_BOUNDARY_COMPLETE = 1;
export const TTS_BOUNDARY_INCOMPLETE = 2;

export interface TtsOperationBoundaryClassification {
  readonly kinds: Uint8Array;
  readonly duplicateMatch?: string;
}

export class TtsOperationBoundaryMatcher {
  readonly #matches: readonly string[];
  readonly #firstEdges: Int32Array;
  readonly #edgeCharacters: Uint16Array;
  readonly #edgeTargets: Int32Array;
  readonly #nextEdges: Int32Array;
  readonly #failures: Int32Array;
  readonly #properPrefixSuffixLengths: Uint16Array;
  readonly #terminalMatches: Int16Array;
  readonly #outputLinks: Int32Array;
  readonly #rootTransitions: ReadonlyMap<number, number>;

  constructor(operations: readonly TtsTextOperation[]) {
    const compiled = compileMatcher(operations);
    this.#matches = compiled.matches;
    this.#firstEdges = compiled.firstEdges;
    this.#edgeCharacters = compiled.edgeCharacters;
    this.#edgeTargets = compiled.edgeTargets;
    this.#nextEdges = compiled.nextEdges;
    this.#failures = compiled.failures;
    this.#properPrefixSuffixLengths = compiled.properPrefixSuffixLengths;
    this.#terminalMatches = compiled.terminalMatches;
    this.#outputLinks = compiled.outputLinks;
    this.#rootTransitions = compiled.rootTransitions;
  }

  classify(text: string, boundaries: readonly number[]): TtsOperationBoundaryClassification {
    const kinds = new Uint8Array(boundaries.length);
    if (this.#matches.length === 0 || boundaries.length === 0) return { kinds };

    const completedRanges = new Int32Array(boundaries.length + 1);
    const seenMatches = new Set<number>();
    let state = 0;
    let nextBoundary = 0;
    for (let index = 0; index < text.length; index += 1) {
      state = this.#transition(state, text.charCodeAt(index));
      const end = index + 1;
      while (boundaries[nextBoundary] === end) {
        if ((this.#properPrefixSuffixLengths[state] ?? 0) > 0) {
          kinds[nextBoundary] = TTS_BOUNDARY_INCOMPLETE;
        }
        nextBoundary += 1;
      }
      for (let outputNode = this.#firstOutput(state); outputNode >= 0; ) {
        const matchId = this.#terminalMatches[outputNode] ?? -1;
        if (seenMatches.has(matchId)) {
          const duplicateMatch = this.#matches[matchId];
          if (duplicateMatch === undefined) {
            throw new Error("TTS text operation matcher output is missing");
          }
          return { kinds, duplicateMatch };
        }
        seenMatches.add(matchId);
        const match = this.#matches[matchId];
        if (match === undefined) throw new Error("TTS text operation matcher output is missing");
        const start = end - match.length;
        const firstBoundary = upperBound(boundaries, start);
        const afterLastBoundary = lowerBound(boundaries, end);
        completedRanges[firstBoundary] = (completedRanges[firstBoundary] ?? 0) + 1;
        completedRanges[afterLastBoundary] = (completedRanges[afterLastBoundary] ?? 0) - 1;
        outputNode = this.#outputLinks[outputNode] ?? -1;
      }
    }

    let activeRanges = 0;
    for (let index = 0; index < boundaries.length; index += 1) {
      activeRanges += completedRanges[index] ?? 0;
      if (activeRanges > 0) kinds[index] = TTS_BOUNDARY_COMPLETE;
    }
    return { kinds };
  }

  createCursor(): TtsOperationBoundaryCursor {
    return new TtsOperationBoundaryCursor({
      matches: this.#matches,
      properPrefixSuffixLengths: this.#properPrefixSuffixLengths,
      terminalMatches: this.#terminalMatches,
      outputLinks: this.#outputLinks,
      transition: (state, character) => this.#transition(state, character),
      firstOutput: (state) => this.#firstOutput(state),
    });
  }

  findDuplicateOperationMatch(text: string): string | undefined {
    if (this.#matches.length === 0) return undefined;
    const seenMatches = new Set<number>();
    let state = 0;
    for (let index = 0; index < text.length; index += 1) {
      state = this.#transition(state, text.charCodeAt(index));
      for (let outputNode = this.#firstOutput(state); outputNode >= 0; ) {
        const matchId = this.#terminalMatches[outputNode] ?? -1;
        if (seenMatches.has(matchId)) return this.#matches[matchId];
        seenMatches.add(matchId);
        outputNode = this.#outputLinks[outputNode] ?? -1;
      }
    }
    return undefined;
  }

  longestProperPrefixSuffixLength(text: string): number {
    let state = 0;
    for (let index = 0; index < text.length; index += 1) {
      state = this.#transition(state, text.charCodeAt(index));
    }
    return this.#properPrefixSuffixLengths[state] ?? 0;
  }

  #transition(current: number, character: number): number {
    if (current === 0) return this.#rootTransitions.get(character) ?? 0;
    let state = current;
    let target = findEdge(
      this.#firstEdges,
      this.#edgeCharacters,
      this.#edgeTargets,
      this.#nextEdges,
      state,
      character,
    );
    while (state !== 0 && target < 0) {
      state = this.#failures[state] ?? 0;
      target = findEdge(
        this.#firstEdges,
        this.#edgeCharacters,
        this.#edgeTargets,
        this.#nextEdges,
        state,
        character,
      );
    }
    return target < 0 ? 0 : target;
  }

  #firstOutput(state: number): number {
    if ((this.#terminalMatches[state] ?? -1) >= 0) return state;
    return this.#outputLinks[state] ?? -1;
  }
}

interface TtsOperationBoundaryCursorOptions {
  readonly matches: readonly string[];
  readonly properPrefixSuffixLengths: Uint16Array;
  readonly terminalMatches: Int16Array;
  readonly outputLinks: Int32Array;
  readonly transition: (state: number, character: number) => number;
  readonly firstOutput: (state: number) => number;
}

interface MatchedTextRange {
  readonly matchId: number;
  start: number;
  end: number;
}

export class TtsOperationBoundaryCursor {
  readonly #options: TtsOperationBoundaryCursorOptions;
  readonly #seenMatches = new Set<number>();
  readonly #ranges: MatchedTextRange[] = [];
  readonly #boundaryStates = new Map<number, number>();
  #boundaryOffsets: number[] = [];
  #stateTail: Uint16Array;
  #stateTailLength = 0;
  #stateTailStart = 0;
  #length = 0;
  #state = 0;
  #maxMatchLength = 0;

  constructor(options: TtsOperationBoundaryCursorOptions) {
    this.#options = options;
    for (const match of options.matches)
      this.#maxMatchLength = Math.max(this.#maxMatchLength, match.length);
    this.#stateTail = new Uint16Array(this.#maxMatchLength);
  }

  append(text: string, boundaries: readonly number[]): string | undefined {
    const previousLength = this.#length;
    const previousBoundary = this.#boundaryOffsets.at(-1);
    if (
      previousBoundary === previousLength &&
      boundaries[lowerBound(boundaries, previousLength)] !== previousLength
    ) {
      this.#boundaryStates.delete(previousBoundary);
      this.#boundaryOffsets.pop();
    }
    let nextBoundary = lowerBound(boundaries, previousLength + 1);
    for (let index = 0; index < text.length; index += 1) {
      const character = text.charCodeAt(index);
      this.#rememberCharacter(character);
      this.#state = this.#options.transition(this.#state, character);
      this.#length += 1;
      const end = this.#length;
      if (boundaries[nextBoundary] === end) {
        this.#boundaryStates.set(end, this.#state);
        this.#boundaryOffsets.push(end);
        nextBoundary += 1;
      }
      for (let outputNode = this.#options.firstOutput(this.#state); outputNode >= 0; ) {
        const matchId = this.#options.terminalMatches[outputNode] ?? -1;
        const match = this.#options.matches[matchId];
        if (match === undefined) throw new Error("TTS text operation matcher output is missing");
        if (this.#seenMatches.has(matchId)) return match;
        this.#seenMatches.add(matchId);
        this.#ranges.push({ matchId, start: end - match.length, end });
        outputNode = this.#options.outputLinks[outputNode] ?? -1;
      }
    }
    return undefined;
  }

  classify(boundaries: readonly number[]): TtsOperationBoundaryClassification {
    const kinds = new Uint8Array(boundaries.length);
    if (boundaries.length === 0) return { kinds };

    const completedRanges = new Int32Array(boundaries.length + 1);
    for (const [index, end] of boundaries.entries()) {
      const state = end === 0 ? 0 : this.#boundaryStates.get(end);
      if (state === undefined) {
        throw new Error("TTS operation cursor boundary state is missing");
      }
      if ((this.#options.properPrefixSuffixLengths[state] ?? 0) > 0) {
        kinds[index] = TTS_BOUNDARY_INCOMPLETE;
      }
    }
    for (const { start, end } of this.#ranges) {
      const firstBoundary = upperBound(boundaries, start);
      const afterLastBoundary = lowerBound(boundaries, end);
      completedRanges[firstBoundary] = (completedRanges[firstBoundary] ?? 0) + 1;
      completedRanges[afterLastBoundary] = (completedRanges[afterLastBoundary] ?? 0) - 1;
    }

    let activeRanges = 0;
    for (let index = 0; index < boundaries.length; index += 1) {
      activeRanges += completedRanges[index] ?? 0;
      if (activeRanges > 0) kinds[index] = TTS_BOUNDARY_COMPLETE;
    }
    return { kinds };
  }

  longestProperPrefixSuffixLength(): number {
    return this.#options.properPrefixSuffixLengths[this.#state] ?? 0;
  }

  safePrefixLength(maximumLength: number): number {
    let safeLength = maximumLength;
    for (const range of this.#ranges) {
      if (range.start < safeLength && range.end > safeLength) {
        safeLength = range.start;
      }
    }
    return safeLength;
  }

  discardPrefix(length: number): void {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.#length) {
      throw new RangeError("TTS operation cursor discard length is invalid");
    }
    if (length === 0) return;
    const remainingLength = this.#length - length;
    const retainedBoundaryOffsets: number[] = [];
    const retainedBoundaryStates: Array<readonly [number, number]> = [];
    for (const offset of this.#boundaryOffsets) {
      if (offset <= length) continue;
      const shiftedOffset = offset - length;
      const state = this.#boundaryStates.get(offset);
      if (state === undefined) throw new Error("TTS operation cursor boundary state is missing");
      retainedBoundaryOffsets.push(shiftedOffset);
      retainedBoundaryStates.push([shiftedOffset, state]);
    }
    this.#boundaryOffsets = retainedBoundaryOffsets;
    this.#boundaryStates.clear();
    for (const [offset, state] of retainedBoundaryStates) {
      this.#boundaryStates.set(offset, state);
    }
    this.#length = remainingLength;
    for (let index = this.#ranges.length - 1; index >= 0; index -= 1) {
      const range = this.#ranges[index];
      if (range === undefined) continue;
      if (range.end <= length) {
        this.#ranges.splice(index, 1);
        continue;
      }
      if (range.start < length) {
        throw new Error("TTS operation cursor cannot discard across an operation match");
      }
      range.start -= length;
      range.end -= length;
    }

    if (remainingLength < this.#maxMatchLength) {
      this.#state = 0;
      const retainedLength = Math.min(remainingLength, this.#stateTailLength);
      const retainedStart =
        (this.#stateTailStart + this.#stateTailLength - retainedLength) % this.#maxMatchLength;
      for (let index = 0; index < retainedLength; index += 1) {
        const character = this.#stateTail[(retainedStart + index) % this.#maxMatchLength] ?? 0;
        this.#state = this.#options.transition(this.#state, character);
      }
      this.#stateTailStart = retainedStart;
      this.#stateTailLength = retainedLength;
    }
  }

  #rememberCharacter(character: number): void {
    if (this.#maxMatchLength === 0) return;
    if (this.#stateTailLength < this.#maxMatchLength) {
      const index = (this.#stateTailStart + this.#stateTailLength) % this.#maxMatchLength;
      this.#stateTail[index] = character;
      this.#stateTailLength += 1;
      return;
    }
    this.#stateTail[this.#stateTailStart] = character;
    this.#stateTailStart = (this.#stateTailStart + 1) % this.#maxMatchLength;
  }
}

interface CompiledMatcher {
  readonly matches: readonly string[];
  readonly firstEdges: Int32Array;
  readonly edgeCharacters: Uint16Array;
  readonly edgeTargets: Int32Array;
  readonly nextEdges: Int32Array;
  readonly failures: Int32Array;
  readonly properPrefixSuffixLengths: Uint16Array;
  readonly terminalMatches: Int16Array;
  readonly outputLinks: Int32Array;
  readonly rootTransitions: ReadonlyMap<number, number>;
}

function compileMatcher(operations: readonly TtsTextOperation[]): CompiledMatcher {
  const matches: string[] = [];
  const matchIds = new Map<string, number>();
  const firstEdges = [-1];
  const edgeCharacters: number[] = [];
  const edgeTargets: number[] = [];
  const nextEdges: number[] = [];
  const failures = [0];
  const properPrefixSuffixLengths = [0];
  const terminalMatches = [-1];
  const outputLinks = [-1];

  for (const operation of operations) {
    let matchId = matchIds.get(operation.match);
    if (matchId === undefined) {
      matchId = matches.length;
      matchIds.set(operation.match, matchId);
      matches.push(operation.match);
    }
    let state = 0;
    for (let index = 0; index < operation.match.length; index += 1) {
      const character = operation.match.charCodeAt(index);
      let target = findMutableEdge(
        firstEdges,
        edgeCharacters,
        edgeTargets,
        nextEdges,
        state,
        character,
      );
      if (target < 0) {
        target = firstEdges.length;
        firstEdges.push(-1);
        failures.push(0);
        properPrefixSuffixLengths.push(0);
        terminalMatches.push(-1);
        outputLinks.push(-1);
        const edgeIndex = edgeCharacters.length;
        edgeCharacters.push(character);
        edgeTargets.push(target);
        nextEdges.push(firstEdges[state] ?? -1);
        firstEdges[state] = edgeIndex;
      }
      state = target;
      if (index < operation.match.length - 1) {
        properPrefixSuffixLengths[state] = index + 1;
      }
    }
    terminalMatches[state] = matchId;
  }

  const queue: number[] = [];
  for (let edge = firstEdges[0] ?? -1; edge >= 0; edge = nextEdges[edge] ?? -1) {
    const child = edgeTargets[edge];
    if (child === undefined) continue;
    failures[child] = 0;
    queue.push(child);
  }

  for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
    const state = queue[queueIndex];
    if (state === undefined) continue;
    for (let edge = firstEdges[state] ?? -1; edge >= 0; edge = nextEdges[edge] ?? -1) {
      const character = edgeCharacters[edge];
      const child = edgeTargets[edge];
      if (character === undefined || child === undefined) continue;
      let failure = failures[state] ?? 0;
      let candidate = findMutableEdge(
        firstEdges,
        edgeCharacters,
        edgeTargets,
        nextEdges,
        failure,
        character,
      );
      while (failure !== 0 && candidate < 0) {
        failure = failures[failure] ?? 0;
        candidate = findMutableEdge(
          firstEdges,
          edgeCharacters,
          edgeTargets,
          nextEdges,
          failure,
          character,
        );
      }
      const failureState = candidate >= 0 && candidate !== child ? candidate : 0;
      failures[child] = failureState;
      outputLinks[child] =
        (terminalMatches[failureState] ?? -1) >= 0
          ? failureState
          : (outputLinks[failureState] ?? -1);
      properPrefixSuffixLengths[child] = Math.max(
        properPrefixSuffixLengths[child] ?? 0,
        properPrefixSuffixLengths[failureState] ?? 0,
      );
      queue.push(child);
    }
  }

  const rootTransitions = new Map<number, number>();
  for (let edge = firstEdges[0] ?? -1; edge >= 0; edge = nextEdges[edge] ?? -1) {
    const character = edgeCharacters[edge];
    const target = edgeTargets[edge];
    if (character !== undefined && target !== undefined) rootTransitions.set(character, target);
  }

  return {
    matches: Object.freeze(matches),
    firstEdges: Int32Array.from(firstEdges),
    edgeCharacters: Uint16Array.from(edgeCharacters),
    edgeTargets: Int32Array.from(edgeTargets),
    nextEdges: Int32Array.from(nextEdges),
    failures: Int32Array.from(failures),
    properPrefixSuffixLengths: Uint16Array.from(properPrefixSuffixLengths),
    terminalMatches: Int16Array.from(terminalMatches),
    outputLinks: Int32Array.from(outputLinks),
    rootTransitions,
  };
}

function findMutableEdge(
  firstEdges: readonly number[],
  edgeCharacters: readonly number[],
  edgeTargets: readonly number[],
  nextEdges: readonly number[],
  state: number,
  character: number,
): number {
  for (let edge = firstEdges[state] ?? -1; edge >= 0; edge = nextEdges[edge] ?? -1) {
    if (edgeCharacters[edge] === character) return edgeTargets[edge] ?? -1;
  }
  return -1;
}

function findEdge(
  firstEdges: Int32Array,
  edgeCharacters: Uint16Array,
  edgeTargets: Int32Array,
  nextEdges: Int32Array,
  state: number,
  character: number,
): number {
  for (let edge = firstEdges[state] ?? -1; edge >= 0; edge = nextEdges[edge] ?? -1) {
    if (edgeCharacters[edge] === character) return edgeTargets[edge] ?? -1;
  }
  return -1;
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
