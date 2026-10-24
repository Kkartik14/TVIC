export type TtsTextOperation =
  | { readonly type: "spell"; readonly match: string }
  | { readonly type: "pause_after"; readonly match: string; readonly durationMs: number }
  | {
      readonly type: "phoneme";
      readonly match: string;
      readonly alphabet: "ipa" | "cmu";
      readonly pronunciation: string;
    };

export type TtsTextPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "pause"; readonly durationMs: number }
  | { readonly type: "spell"; readonly text: string }
  | {
      readonly type: "phoneme";
      readonly text: string;
      readonly alphabet: "ipa" | "cmu";
      readonly pronunciation: string;
    };

const MAX_TEXT_CODE_POINTS = 20_000;
const MAX_OPERATIONS = 32;
const MAX_TARGET_CODE_POINTS = 128;
const MAX_PRONUNCIATION_CODE_POINTS = 128;
const MAX_PAUSE_MS = 3_000;

interface TargetOperations {
  readonly match: string;
  readonly index: number;
  spell: boolean;
  pauseDurationMs?: number;
  phoneme?: { readonly alphabet: "ipa" | "cmu"; readonly pronunciation: string };
}

export function createTtsTextParts(
  text: string,
  operations: readonly TtsTextOperation[],
): readonly TtsTextPart[] {
  assertText(text);
  const validatedOperations = validateTtsTextOperations(operations);

  const targets = new Map<string, TargetOperations>();
  for (const operation of validatedOperations) {
    const target = getOrCreateTarget(text, operation, targets);
    applyOperation(target, operation);
  }

  const orderedTargets = [...targets.values()].sort((left, right) => left.index - right.index);
  assertNoOverlap(orderedTargets);

  const parts: TtsTextPart[] = [];
  let cursor = 0;
  for (const target of orderedTargets) {
    appendText(parts, text.slice(cursor, target.index));
    if (target.phoneme !== undefined) {
      parts.push({
        type: "phoneme",
        text: target.match,
        alphabet: target.phoneme.alphabet,
        pronunciation: target.phoneme.pronunciation,
      });
    } else if (target.spell) {
      parts.push({ type: "spell", text: target.match });
    } else {
      appendText(parts, target.match);
    }
    if (target.pauseDurationMs !== undefined) {
      parts.push({ type: "pause", durationMs: target.pauseDurationMs });
    }
    cursor = target.index + target.match.length;
  }
  appendText(parts, text.slice(cursor));
  return parts;
}

export function ttsTextPartsToPlainText(parts: readonly TtsTextPart[]): string {
  return parts.map((part) => (part.type === "pause" ? "" : part.text)).join("");
}

export function validateTtsTextOperations(
  operations: readonly TtsTextOperation[],
): readonly TtsTextOperation[] {
  if (!Array.isArray(operations) || operations.length > MAX_OPERATIONS) {
    throw new TypeError(`TTS text operations must be an array of at most ${MAX_OPERATIONS} items`);
  }

  const validated: TtsTextOperation[] = [];
  const targets = new Map<string, TargetOperations>();
  for (const value of operations as readonly unknown[]) {
    if (value === null || typeof value !== "object") {
      throw new TypeError("TTS text operation must be an object");
    }
    const operation = value as Record<string, unknown>;
    const match = operation.match;
    validateMatch(match as string);
    let copy: TtsTextOperation;
    switch (operation.type) {
      case "spell":
        copy = { type: "spell", match: match as string };
        break;
      case "pause_after":
        copy = {
          type: "pause_after",
          match: match as string,
          durationMs: operation.durationMs as number,
        };
        break;
      case "phoneme":
        copy = {
          type: "phoneme",
          match: match as string,
          alphabet: operation.alphabet as "ipa" | "cmu",
          pronunciation: operation.pronunciation as string,
        };
        break;
      default:
        throw new TypeError("TTS text operation type is unsupported");
    }

    let target = targets.get(copy.match);
    if (target === undefined) {
      target = { match: copy.match, index: 0, spell: false };
      targets.set(copy.match, target);
    }
    applyOperation(target, copy);
    validated.push(Object.freeze(copy));
  }
  return Object.freeze(validated);
}

function assertText(text: string): void {
  if (typeof text !== "string") throw new TypeError("TTS text must be a string");
  if (Array.from(text).length > MAX_TEXT_CODE_POINTS) {
    throw new TypeError(`TTS text must not exceed ${MAX_TEXT_CODE_POINTS} code points`);
  }
}

function getOrCreateTarget(
  text: string,
  operation: TtsTextOperation,
  targets: Map<string, TargetOperations>,
): TargetOperations {
  if (operation === null || typeof operation !== "object") {
    throw new TypeError("TTS text operation must be an object");
  }
  validateMatch(operation.match);
  let target = targets.get(operation.match);
  if (target !== undefined) return target;

  const firstIndex = text.indexOf(operation.match);
  if (firstIndex < 0) throw new TypeError("TTS text operation match was not found");
  if (text.indexOf(operation.match, firstIndex + operation.match.length) >= 0) {
    throw new TypeError("TTS text operation match must be unique in the text");
  }
  target = { match: operation.match, index: firstIndex, spell: false };
  targets.set(operation.match, target);
  return target;
}

function validateMatch(match: string): void {
  if (typeof match !== "string" || match.trim().length === 0) {
    throw new TypeError("TTS text operation match must be a non-empty string");
  }
  if (Array.from(match).length > MAX_TARGET_CODE_POINTS || /\p{Cc}/u.test(match)) {
    throw new TypeError(
      `TTS text operation match must be at most ${MAX_TARGET_CODE_POINTS} control-free code points`,
    );
  }
}

function applyOperation(target: TargetOperations, operation: TtsTextOperation): void {
  switch (operation.type) {
    case "spell":
      if (target.spell || target.phoneme !== undefined) {
        throw new TypeError("TTS text operation has conflicting pronunciation operations");
      }
      target.spell = true;
      return;
    case "pause_after":
      if (target.pauseDurationMs !== undefined) {
        throw new TypeError("TTS text operation contains duplicate pause_after operations");
      }
      if (
        !Number.isSafeInteger(operation.durationMs) ||
        operation.durationMs < 0 ||
        operation.durationMs > MAX_PAUSE_MS
      ) {
        throw new TypeError(
          `TTS text operation durationMs must be an integer from 0 to ${MAX_PAUSE_MS}`,
        );
      }
      target.pauseDurationMs = operation.durationMs;
      return;
    case "phoneme":
      if (target.phoneme !== undefined || target.spell) {
        throw new TypeError("TTS text operation has conflicting pronunciation operations");
      }
      if (operation.alphabet !== "ipa" && operation.alphabet !== "cmu") {
        throw new TypeError("TTS phoneme alphabet must be ipa or cmu");
      }
      if (
        typeof operation.pronunciation !== "string" ||
        operation.pronunciation.trim().length === 0 ||
        Array.from(operation.pronunciation).length > MAX_PRONUNCIATION_CODE_POINTS ||
        /\p{Cc}/u.test(operation.pronunciation)
      ) {
        throw new TypeError(
          `TTS phoneme pronunciation must be a non-empty, control-free string of at most ${MAX_PRONUNCIATION_CODE_POINTS} code points`,
        );
      }
      target.phoneme = { alphabet: operation.alphabet, pronunciation: operation.pronunciation };
      return;
    default:
      throw new TypeError("TTS text operation type is unsupported");
  }
}

function assertNoOverlap(targets: readonly TargetOperations[]): void {
  for (let index = 1; index < targets.length; index += 1) {
    const previous = targets[index - 1];
    const current = targets[index];
    if (previous === undefined || current === undefined) continue;
    if (current.index < previous.index + previous.match.length) {
      throw new TypeError("TTS text operation matches overlap");
    }
  }
}

function appendText(parts: TtsTextPart[], text: string): void {
  if (text.length === 0) return;
  const previous = parts.at(-1);
  if (previous?.type === "text") {
    parts[parts.length - 1] = { type: "text", text: `${previous.text}${text}` };
  } else {
    parts.push({ type: "text", text });
  }
}
