import type { Memory } from "@tvic/core";

export interface MemoryExpectation {
  toBe(expected: unknown): void;
  toBeDefined(): void;
  toBeGreaterThan(expected: number): void;
  toBeNull(): void;
  toBeTruthy(): void;
  toEqual(expected: unknown): void;
  toHaveLength(expected: number): void;
  toMatch(expected: RegExp): void;
  readonly not: {
    toBeNull(): void;
  };
  readonly rejects: {
    toThrow(expected?: RegExp | string): Promise<void>;
  };
}

/**
 * The contract test runner takes an initializer that produces a fresh
 * `Memory` implementation per test. The caller supplies the test framework's
 * registration and assertion functions so importing this package never starts
 * or depends on a particular test runner process.
 */
export interface MemoryContractTestApi {
  readonly expect: (actual: unknown, message?: string) => MemoryExpectation;
  readonly it: (name: string, fn: () => void | Promise<void>) => unknown;
}

export interface MemoryContractTestInitializer {
  readonly name: string;
  /** Factory that returns a fresh Memory implementation. */
  createMemory(): Memory | Promise<Memory>;
  /** Optional teardown (drop tables, close connections, clear in-memory state). */
  teardown?(memory: Memory): Promise<void> | void;
}
