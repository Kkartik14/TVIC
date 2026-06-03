import { describe, expect, it } from "vitest";

import type { CallInspection, SpanView, TurnInspection } from "@tvic/tracing";

import {
  cursorPct,
  fmtMs,
  isHotResponse,
  pct,
  playoutLabel,
  selectInitialTurn,
  spanBox,
  toAudioSeconds,
} from "../lib/view";

describe("view helpers", () => {
  it("formats milliseconds and percentages", () => {
    expect(fmtMs(undefined)).toBe("–");
    expect(fmtMs(null)).toBe("–");
    expect(fmtMs(123.4)).toBe("123ms");
    expect(pct(150)).toBe("100%");
    expect(pct(-5)).toBe("0%");
    expect(pct(42)).toBe("42%");
  });

  it("selects the query-param turn when present, else the first", () => {
    const call = { turns: [{ turnId: "a" }, { turnId: "b" }] };
    expect(selectInitialTurn(call, "b")).toBe("b");
    expect(selectInitialTurn(call, "nope")).toBe("a");
    expect(selectInitialTurn(call, undefined)).toBe("a");
    expect(selectInitialTurn({ turns: [] }, "x")).toBeUndefined();
  });

  it("positions a span within its turn window", () => {
    const turn = { startedMs: 100, endedMs: 600 } as TurnInspection;
    const span = { startMs: 200, endMs: 350 } as SpanView;
    const box = spanBox(span, turn);
    expect(box.left).toBe("20%"); // (200-100)/500
    expect(box.width).toBe("30%"); // (350-200)/500
  });

  it("maps a call-clock offset to a cursor percentage and audio seconds", () => {
    const call = { startMs: 1000, endMs: 3000 } as CallInspection;
    expect(cursorPct(2000, call)).toBe(50);
    expect(cursorPct(0, call)).toBe(0); // clamped
    expect(toAudioSeconds(2000, call)).toBe(1); // (2000-1000)/1000
  });

  it("labels playout state honestly (sent vs heard)", () => {
    expect(playoutLabel("heard")).toBe("heard");
    expect(playoutLabel("unconfirmed")).toBe("sent, not confirmed");
    expect(playoutLabel("cancelled")).toBe("cancelled");
    expect(playoutLabel("none")).toBe("no audio");
  });

  it("flags a hot response only above the 1s budget", () => {
    expect(isHotResponse({ latency: { firstAudioMs: 1200 } } as TurnInspection)).toBe(true);
    expect(isHotResponse({ latency: { firstAudioMs: 800 } } as TurnInspection)).toBe(false);
    expect(isHotResponse({ latency: {} } as TurnInspection)).toBe(false);
  });
});
