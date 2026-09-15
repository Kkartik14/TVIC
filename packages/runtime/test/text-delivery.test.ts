import { describe, expect, it, vi } from "vitest";

import type { CallHandle, Turn } from "@tvic/core";

import { deliverAssistantText } from "../src/text-delivery.js";

describe("text delivery", () => {
  it("returns false when a text transport never settles", async () => {
    vi.useFakeTimers();
    try {
      const running = deliverAssistantText({
        callHandle: {
          deliverText: async () => new Promise<boolean>(() => {}),
        } as unknown as CallHandle,
        turn: { id: "turn_text_timeout", sequence: 1 } as Turn,
        text: "hello",
        audioDelivered: false,
        cancelledByBargeIn: false,
        timeoutMs: 10,
      });

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(10);
      await expect(running).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
