import { describe, expect, it } from "vitest";

import { TerminalArbiter, type LiveTerminalSource } from "../src/terminal-arbitration.js";

const sources: readonly LiveTerminalSource[] = [
  "operator_stop",
  "caller_abort",
  "run_timeout",
  "remote_transport",
  "provider_runtime",
  "normal_completion",
];

function candidate(source: LiveTerminalSource) {
  return { source } as const;
}

describe("TerminalArbiter", () => {
  it.each([
    ["operator_stop", "remote_transport"],
    ["remote_transport", "operator_stop"],
    ["caller_abort", "provider_runtime"],
    ["provider_runtime", "caller_abort"],
    ["run_timeout", "remote_transport"],
    ["remote_transport", "run_timeout"],
    ["remote_transport", "provider_runtime"],
    ["provider_runtime", "remote_transport"],
    ["normal_completion", "caller_abort"],
    ["caller_abort", "normal_completion"],
  ] as const)("uses priority instead of callback order for %s and %s", async (first, second) => {
    const arbiter = new TerminalArbiter();
    const priority = (source: LiveTerminalSource): number =>
      ({
        operator_stop: 100,
        caller_abort: 90,
        run_timeout: 80,
        remote_transport: 70,
        provider_runtime: 60,
        normal_completion: 0,
      })[source];
    const expected = priority(first) >= priority(second) ? first : second;
    arbiter.dispatchBatch(() => {
      arbiter.offerTerminal(candidate(first));
      arbiter.offerTerminal(candidate(second));
    });

    await expect(arbiter.waitForCommit()).resolves.toMatchObject({ source: expected });
  });

  it("reuses one batch for nested synchronous dispatch", async () => {
    const arbiter = new TerminalArbiter();
    arbiter.dispatchBatch(() => {
      arbiter.offerTerminal(candidate("normal_completion"));
      arbiter.dispatchBatch(() => {
        arbiter.offerTerminal(candidate("provider_runtime"));
      });
    });

    const claim = await arbiter.waitForCommit();
    expect(claim).toMatchObject({ source: "provider_runtime", kind: "failed" });
  });

  it("commits sequential top-level batches in order", async () => {
    const arbiter = new TerminalArbiter();
    arbiter.dispatchBatch(() => {
      arbiter.offerTerminal(candidate("remote_transport"));
    });
    arbiter.dispatchBatch(() => {
      arbiter.offerTerminal(candidate("operator_stop"));
    });

    const claim = await arbiter.waitForCommit();
    expect(claim?.source).toBe("remote_transport");
  });

  it("allows a later batch only when the earlier batch offered nothing", async () => {
    const arbiter = new TerminalArbiter();
    arbiter.dispatchBatch(() => undefined);
    arbiter.dispatchBatch(() => {
      arbiter.offerTerminal(candidate("provider_runtime"));
    });

    await expect(arbiter.waitForCommit()).resolves.toMatchObject({ source: "provider_runtime" });
  });

  it("does not let a later host callback replace a committed claim", async () => {
    const arbiter = new TerminalArbiter();
    arbiter.dispatchBatch(() => {
      arbiter.offerTerminal(candidate("remote_transport"));
    });
    await arbiter.waitForCommit();

    arbiter.dispatchBatch(() => {
      arbiter.offerTerminal(candidate("operator_stop"));
    });
    await arbiter.waitForCommit();
    expect(arbiter.claim?.source).toBe("remote_transport");
  });

  it("normalizes a throwing boundary callback and rethrows its original error", async () => {
    const arbiter = new TerminalArbiter();
    const original = new Error("adapter exploded");
    expect(() =>
      arbiter.dispatchBatch(() => {
        throw original;
      }),
    ).toThrow(original);

    await expect(arbiter.waitForCommit()).resolves.toMatchObject({
      kind: "failed",
      source: "provider_runtime",
      error: { code: "voice_runtime.run_failed" },
    });
  });

  it("lets an offered higher-priority terminal win over a later callback throw", async () => {
    const arbiter = new TerminalArbiter();
    const original = new Error("late callback failure");
    expect(() =>
      arbiter.dispatchBatch(() => {
        arbiter.offerTerminal(candidate("operator_stop"));
        throw original;
      }),
    ).toThrow(original);

    await expect(arbiter.waitForCommit()).resolves.toMatchObject({ source: "operator_stop" });
  });

  it("rejects an offer outside a scheduler batch", () => {
    const arbiter = new TerminalArbiter();
    expect(() => arbiter.offerTerminal(candidate("provider_runtime"))).toThrow(
      /inside dispatchBatch/,
    );
  });

  it("rejects async callbacks instead of extending their batch", async () => {
    const arbiter = new TerminalArbiter();
    await expect(
      Promise.resolve().then(() =>
        arbiter.dispatchBatch(async () => {
          await Promise.resolve();
          arbiter.offerTerminal(candidate("normal_completion"));
        }),
      ),
    ).rejects.toThrow("must be synchronous");

    await expect(arbiter.waitForCommit()).resolves.toMatchObject({ source: "provider_runtime" });
  });

  it.each(sources)("supports the %s terminal source in an explicit batch", async (source) => {
    const arbiter = new TerminalArbiter();
    arbiter.dispatchBatch(() => arbiter.offerTerminal(candidate(source)));
    await expect(arbiter.waitForCommit()).resolves.toMatchObject({ source });
  });
});
