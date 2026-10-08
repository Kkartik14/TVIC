import { describe, expect, it, vi } from "vitest";

import { bindHoldToTalkButton } from "../public/hold-to-talk.js";

describe("hold-to-talk button input", () => {
  it.each([" ", "Enter"])("starts and ends a turn with keyboard key %j", (key) => {
    const button = new FakeButton();
    const client = {
      connected: true,
      mode: "push_to_talk",
      startTurn: vi.fn(),
      endTurn: vi.fn(),
    };
    bindHoldToTalkButton(button, () => client);

    const down = button.emit("keydown", { key, repeat: false });
    button.emit("keydown", { key, repeat: true });
    const up = button.emit("keyup", { key, repeat: false });
    button.emit("keyup", { key, repeat: false });

    expect(down.defaultPrevented).toBe(true);
    expect(up.defaultPrevented).toBe(true);
    expect(client.startTurn).toHaveBeenCalledOnce();
    expect(client.endTurn).toHaveBeenCalledOnce();
  });

  it("ends a held turn on focus loss and ignores duplicate releases", () => {
    const button = new FakeButton();
    const client = {
      connected: true,
      mode: "push_to_talk",
      startTurn: vi.fn(),
      endTurn: vi.fn(),
    };
    bindHoldToTalkButton(button, () => client);

    button.emit("pointerdown");
    button.emit("blur");
    button.emit("pointerup");

    expect(client.startTurn).toHaveBeenCalledOnce();
    expect(client.endTurn).toHaveBeenCalledOnce();
  });
});

class FakeButton {
  #listeners = new Map();

  addEventListener(type, listener) {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.#listeners.get(type)?.delete(listener);
  }

  emit(type, properties = {}) {
    let defaultPrevented = false;
    const event = {
      ...properties,
      get defaultPrevented() {
        return defaultPrevented;
      },
      preventDefault() {
        defaultPrevented = true;
      },
    };
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
    return event;
  }
}
