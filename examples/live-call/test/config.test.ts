import { afterEach, describe, expect, it } from "vitest";

import { boundedInt } from "../src/config.js";

const KEY = "TVIC_TEST_BOUNDED_INT";

afterEach(() => {
  delete process.env[KEY];
});

describe("boundedInt", () => {
  it("returns the fallback when unset", () => {
    expect(boundedInt(KEY, 8080, 1, 65535)).toBe(8080);
  });

  it("parses a valid in-range integer", () => {
    process.env[KEY] = "9090";
    expect(boundedInt(KEY, 8080, 1, 65535)).toBe(9090);
  });

  it("throws on non-numeric values", () => {
    process.env[KEY] = "12ab";
    expect(() => boundedInt(KEY, 8080, 1, 65535)).toThrow();
    process.env[KEY] = "-5";
    expect(() => boundedInt(KEY, 8080, 1, 65535)).toThrow();
  });

  it("throws when out of range", () => {
    process.env[KEY] = "70000";
    expect(() => boundedInt(KEY, 8080, 1, 65535)).toThrow(/between/);
    process.env[KEY] = "0";
    expect(() => boundedInt(KEY, 8080, 1, 65535)).toThrow(/between/);
  });
});
