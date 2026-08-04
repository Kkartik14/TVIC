import { describe, expect, it } from "vitest";

import { shouldDeliverText } from "../src/index.js";

describe("text delivery policy", () => {
  it("defaults to text only when audio did not deliver", () => {
    expect(
      shouldDeliverText({
        audioDelivered: false,
        hasTransport: true,
        cancelledByBargeIn: false,
      }),
    ).toBe(true);
    expect(
      shouldDeliverText({
        audioDelivered: true,
        hasTransport: true,
        cancelledByBargeIn: false,
      }),
    ).toBe(false);
  });

  it("supports always/never without overriding transport or barge-in safety", () => {
    expect(
      shouldDeliverText({
        mode: "always",
        audioDelivered: true,
        hasTransport: true,
        cancelledByBargeIn: false,
      }),
    ).toBe(true);
    expect(
      shouldDeliverText({
        mode: "never",
        audioDelivered: false,
        hasTransport: true,
        cancelledByBargeIn: false,
      }),
    ).toBe(false);
    expect(
      shouldDeliverText({
        mode: "always",
        audioDelivered: false,
        hasTransport: true,
        cancelledByBargeIn: true,
      }),
    ).toBe(false);
  });
});
