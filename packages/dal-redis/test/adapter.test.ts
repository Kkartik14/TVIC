import { describe, expect, it } from "vitest";
import type { DurableOutboxEvent, SessionId, StoredSessionRecord, Timestamp } from "@tvic/core";

import {
  RedisDurableRuntimeStore,
  RedisSessionLeaseStore,
  RedisOutboxCacheProjector,
  RedisToolIdempotencyStore,
  type RedisClient,
  type RedisMulti,
} from "../src/index.js";
import { idempotencyKey } from "../src/keys.js";

class FakeRedis implements RedisClient {
  readonly values = new Map<string, string>();
  readonly sorted = new Map<string, Map<string, number>>();
  nowMs = 100;

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string, options?: { readonly NX?: boolean }): Promise<"OK" | null> {
    if (options?.NX && this.values.has(key)) return null;
    this.values.set(key, value);
    return "OK";
  }

  async del(...keys: readonly string[]): Promise<number> {
    return keys.reduce((count, key) => {
      const deleted = this.values.delete(key);
      this.sorted.delete(key);
      return count + (deleted ? 1 : 0);
    }, 0);
  }

  async eval(script: string, keys: readonly string[], args: readonly string[]): Promise<unknown> {
    if (script.includes("redis.call('SET', ARGV[6], ARGV[5])")) {
      const rawLease = this.values.get(keys[2]!);
      if (!rawLease) return 0;
      const lease = JSON.parse(rawLease) as {
        holder: string;
        fence: number;
        expiresAtMs: number;
      };
      if (
        lease.holder !== args[1] ||
        lease.fence !== Number(args[3]) ||
        lease.expiresAtMs <= this.nowMs
      ) {
        return 0;
      }
      const existingRaw = this.values.get(keys[0]!);
      if (existingRaw && existingRaw !== args[0]) return -1;
      if (!existingRaw) {
        this.values.set(keys[0]!, args[0]!);
      }
      this.zadd(keys[1]!, Number(args[6]), args[7]!);
      if (args[4]) this.values.set(args[5]!, args[4]!);
      return 1;
    }
    if (script.includes("existingRaw and existingRaw ~= ARGV[1]")) {
      const existingRaw = this.values.get(keys[0]!);
      if (existingRaw && existingRaw !== args[0]) return -1;
      const rawLease = this.values.get(keys[2]!);
      const current = rawLease
        ? (JSON.parse(rawLease) as {
            sessionId: string;
            holder: string;
            fence: number;
            expiresAtMs: number;
          })
        : undefined;
      if (current && current.expiresAtMs > this.nowMs) {
        return current.holder === args[1] ? rawLease : 0;
      }
      const lease = {
        sessionId: args[2],
        holder: args[1],
        fence: (current?.fence ?? 0) + 1,
        acquiredAtMs: this.nowMs,
        renewedAtMs: this.nowMs,
        expiresAtMs: this.nowMs + Number(args[3]),
      };
      const encoded = JSON.stringify(lease);
      this.values.set(keys[2]!, encoded);
      this.zadd(keys[3]!, lease.expiresAtMs, args[4]!);
      return encoded;
    }
    if (script.includes("next.sessionId = ARGV[4]")) {
      const rawLease = this.values.get(keys[0]!);
      if (!rawLease) return [-1, ""];
      const lease = JSON.parse(rawLease) as {
        holder: string;
        fence: number;
        expiresAtMs: number;
      };
      if (
        lease.holder !== args[0] ||
        lease.fence !== Number(args[1]) ||
        lease.expiresAtMs <= this.nowMs
      ) {
        return [-1, ""];
      }
      const currentRaw = this.values.get(keys[1]!);
      if (currentRaw) {
        const current = JSON.parse(currentRaw) as {
          toolId?: string;
          toolVersion?: string;
          requestHash: string;
          status: string;
          owner: string;
          sessionId?: string;
          claimedFence?: number;
          expiresAtMs: number;
        };
        if (current.expiresAtMs > this.nowMs) {
          if (
            (args[4] && current.toolId && args[4] !== current.toolId) ||
            (args[5] && current.toolVersion && args[5] !== current.toolVersion) ||
            current.requestHash !== args[6]
          ) {
            return [-2, currentRaw];
          }
          if (current.status === "succeeded") return [2, currentRaw];
          if (current.status === "claimed") {
            const stale =
              Boolean(args[3]) &&
              current.sessionId === args[3] &&
              current.claimedFence !== undefined &&
              current.claimedFence < Number(args[1]);
            if (current.owner !== args[7] && !stale) return [0, currentRaw];
            if (!stale) return [1, currentRaw];
          }
        }
      }
      const record = {
        key: args[2],
        ...(args[3] ? { sessionId: args[3], claimedFence: Number(args[1]) } : {}),
        ...(args[4] ? { toolId: args[4] } : {}),
        ...(args[5] ? { toolVersion: args[5] } : {}),
        requestHash: args[6],
        status: "claimed",
        owner: args[7],
        expiresAtMs: this.nowMs + Number(args[8]),
      };
      const encoded = JSON.stringify(record);
      this.values.set(keys[1]!, encoded);
      return [1, encoded];
    }
    if (script.includes("current.status = ARGV[5]")) {
      const rawLease = this.values.get(keys[0]!);
      const rawCurrent = this.values.get(keys[1]!);
      if (!rawLease) return [-1, ""];
      const lease = JSON.parse(rawLease) as { holder: string; fence: number; expiresAtMs: number };
      if (
        lease.holder !== args[0] ||
        lease.fence !== Number(args[1]) ||
        lease.expiresAtMs <= this.nowMs
      ) {
        return [-1, ""];
      }
      if (!rawCurrent) return [-2, ""];
      const current = JSON.parse(rawCurrent) as {
        requestHash: string;
        owner: string;
        sessionId?: string;
        status: string;
        expiresAtMs: number;
        claimedFence?: number;
        output?: unknown;
        error?: unknown;
      };
      if (
        current.expiresAtMs <= this.nowMs ||
        current.requestHash !== args[2] ||
        current.owner !== args[3] ||
        (current.sessionId !== undefined && current.sessionId !== args[8])
      ) {
        return [-2, rawCurrent];
      }
      if (current.status !== "claimed") return [2, rawCurrent];
      current.status = args[4]!;
      current.expiresAtMs = this.nowMs + Number(args[5]);
      current.claimedFence ??= Number(args[1]);
      if (args[6]) current.output = JSON.parse(args[6]);
      else delete current.output;
      if (args[7]) current.error = JSON.parse(args[7]);
      else delete current.error;
      const encoded = JSON.stringify(current);
      this.values.set(keys[1]!, encoded);
      return [1, encoded];
    }
    if (script.includes("currentRaw = redis.call('GET', KEYS[3])")) {
      const current = this.values.get(keys[2]!);
      if (current) {
        const metadata = JSON.parse(current) as { fence: number; version: number };
        const fence = Number(args[1]);
        const version = Number(args[2]);
        if (metadata.fence > fence || (metadata.fence === fence && metadata.version >= version)) {
          return 0;
        }
      }
      this.values.set(keys[0]!, args[0]!);
      this.values.set(
        keys[2]!,
        JSON.stringify({ fence: Number(args[1]), version: Number(args[2]) }),
      );
      this.zadd(keys[1]!, Number(args[3]), keys[0]!);
      return 1;
    }
    if (script.includes("local arg = 3")) {
      const rawLease = this.values.get(keys[0]!);
      if (!rawLease) return 0;
      const lease = JSON.parse(rawLease) as {
        holder: string;
        fence: number;
        expiresAtMs: number;
      };
      if (
        lease.holder !== args[0] ||
        lease.fence !== Number(args[1]) ||
        lease.expiresAtMs <= this.nowMs
      ) {
        return 0;
      }
      for (let index = 1; index < keys.length; index += 1) {
        const value = args[1 + (index - 1) * 4]!;
        const indexKey = args[2 + (index - 1) * 4]!;
        const score = Number(args[3 + (index - 1) * 4]);
        const expected = args[4 + (index - 1) * 4]!;
        const current = this.values.get(keys[index]!);
        if (
          (expected === "*" && current && current !== value) ||
          (expected === "__absent__" && current) ||
          (expected !== "*" && expected !== "__absent__" && current !== expected)
        ) {
          return -1;
        }
        this.values.set(keys[index]!, value);
        if (indexKey) this.zadd(indexKey, score, keys[index]!);
      }
      return 1;
    }
    if (script.includes("local next = {sessionId = ARGV[2]")) {
      const currentRaw = this.values.get(keys[0]!);
      const current = currentRaw
        ? (JSON.parse(currentRaw) as { holder: string; fence: number; expiresAtMs: number })
        : undefined;
      if (current && current.expiresAtMs > this.nowMs) {
        return current.holder === args[0] ? currentRaw : "";
      }
      const lease = {
        sessionId: args[1],
        holder: args[0],
        fence: (current?.fence ?? 0) + 1,
        acquiredAtMs: this.nowMs,
        renewedAtMs: this.nowMs,
        expiresAtMs: this.nowMs + Number(args[2]),
      };
      const encoded = JSON.stringify(lease);
      this.values.set(keys[0]!, encoded);
      this.zadd(keys[1]!, lease.expiresAtMs, args[3]!);
      return encoded;
    }
    if (script.includes("current.expiresAtMs = now")) {
      const raw = this.values.get(keys[0]!);
      if (!raw) return 0;
      const lease = JSON.parse(raw) as { holder: string; fence: number } & Record<string, unknown>;
      if (lease.holder !== args[0] || lease.fence !== Number(args[1])) return 0;
      lease.renewedAtMs = this.nowMs;
      lease.expiresAtMs = this.nowMs;
      this.values.set(keys[0]!, JSON.stringify(lease));
      this.zadd(keys[1]!, this.nowMs, args[2]!);
      return 1;
    }
    if (script.includes("current.renewedAtMs = now")) {
      const raw = this.values.get(keys[0]!);
      if (!raw) return "";
      const lease = JSON.parse(raw) as {
        holder: string;
        fence: number;
        expiresAtMs: number;
        renewedAtMs: number;
      };
      if (
        lease.holder !== args[0] ||
        lease.fence !== Number(args[1]) ||
        lease.expiresAtMs <= this.nowMs
      ) {
        return "";
      }
      lease.renewedAtMs = this.nowMs;
      lease.expiresAtMs = this.nowMs + Number(args[2]);
      const encoded = JSON.stringify(lease);
      this.values.set(keys[0]!, encoded);
      this.zadd(keys[1]!, lease.expiresAtMs, args[3]!);
      return encoded;
    }
    throw new Error("FakeRedis does not recognize this script");
  }

  async scan(): Promise<readonly [string, readonly string[]]> {
    return ["0", [...this.values.keys()]];
  }

  async zrange(key: string, start: number, stop: number): Promise<readonly string[]> {
    const members = [...(this.sorted.get(key)?.entries() ?? [])]
      .sort(
        ([aMember, aScore], [bMember, bScore]) => aScore - bScore || aMember.localeCompare(bMember),
      )
      .map(([member]) => member);
    const end = stop < 0 ? members.length : stop + 1;
    return members.slice(start, end);
  }

  async zrangebyscore(key: string, min: number, max: number): Promise<readonly string[]> {
    const members = [...(this.sorted.get(key)?.entries() ?? [])]
      .filter(([, score]) => score >= min && score <= max)
      .sort(
        ([aMember, aScore], [bMember, bScore]) => aScore - bScore || aMember.localeCompare(bMember),
      )
      .map(([member]) => member);
    return members;
  }

  async time(): Promise<readonly [string, string]> {
    return [String(Math.floor(this.nowMs / 1_000)), String((this.nowMs % 1_000) * 1_000)];
  }

  async watch(): Promise<void> {
    return;
  }

  async unwatch(): Promise<void> {
    return;
  }

  multi(): RedisMulti {
    const commands: Array<() => Promise<unknown>> = [];
    return {
      set: (key, value) => {
        commands.push(() => this.set(key, value));
        return this.multiChain(commands);
      },
      del: (...keys) => {
        commands.push(() => this.del(...keys));
        return this.multiChain(commands);
      },
      exec: async () => Promise.all(commands.map((command) => command())),
    };
  }

  private multiChain(commands: Array<() => Promise<unknown>>): RedisMulti {
    return {
      set: (key, value) => {
        commands.push(() => this.set(key, value));
        return this.multiChain(commands);
      },
      del: (...keys) => {
        commands.push(() => this.del(...keys));
        return this.multiChain(commands);
      },
      exec: async () => Promise.all(commands.map((command) => command())),
    };
  }

  private zadd(key: string, score: number, member: string): void {
    const set = this.sorted.get(key) ?? new Map<string, number>();
    set.set(member, score);
    this.sorted.set(key, set);
  }
}

describe("Redis durable primitives", () => {
  it("keeps same-holder lease retries stable and fences expiry", async () => {
    let now = 100;
    const client = new FakeRedis();
    const leases = new RedisSessionLeaseStore(client, { nowMs: () => now });
    const first = await leases.acquire("session_redis" as SessionId, "holder_a", 1000);
    expect(await leases.acquire("session_redis" as SessionId, "holder_a", 1000)).toEqual(first);
    expect(await leases.acquire("session_redis" as SessionId, "holder_b", 1000)).toBeNull();
    client.nowMs = 1200;
    expect((await leases.acquire("session_redis" as SessionId, "holder_b", 1000))?.fence).toBe(2);
  });

  it("pages recovery candidates in the cursor's stable id order", async () => {
    const client = new FakeRedis();
    const leases = new RedisSessionLeaseStore(client);
    await leases.acquire("z_session" as SessionId, "holder_z", 100);
    await leases.acquire("a_session" as SessionId, "holder_a", 200);
    client.nowMs = 500;

    const first = await leases.listRecoveryCandidates({ nowMs: 500, limit: 1 });
    expect(first).toEqual({ sessionIds: ["a_session"], nextCursor: "a_session" });
    await expect(
      leases.listRecoveryCandidates({ nowMs: 500, limit: 1, cursor: first.nextCursor! }),
    ).resolves.toEqual({ sessionIds: ["z_session"] });
  });

  it("finalizes a new session and its initial outbox event in one commit", async () => {
    const client = new FakeRedis();
    const store = new RedisDurableRuntimeStore(client);
    const sessionId = "session:initial" as SessionId;
    const record: StoredSessionRecord = {
      session: {
        id: sessionId,
        agentId: "agent_initial" as never,
        status: "active",
        channel: "simulated",
        memoryRefs: [],
        createdAt: "2026-08-29T00:00:00.000Z" as Timestamp,
        startedAt: "2026-08-29T00:00:00.000Z" as Timestamp,
        state: { variables: {}, pendingToolCallIds: [], turnSequence: 0 },
      },
      runtime: { monotonicStartedAtMs: 1 },
      version: 1,
    };

    const lease = await store.createSessionWithLease(record, "initial_holder", 1_000, (owned) => ({
      id: `session:${sessionId}:1:${owned.fence}`,
      aggregateType: "session",
      aggregateId: sessionId,
      sessionId,
      version: 1,
      fence: owned.fence,
      envelope: {
        kind: "session",
        schemaVersion: 1,
        payload: record.session,
        runtime: record.runtime,
        version: 1,
      },
    }));

    expect(lease?.fence).toBe(1);
    const eventKey = "tvic:v1:outbox:session%3Asession%3Ainitial%3A1%3A1";
    const event = JSON.parse(client.values.get(eventKey) ?? "null") as {
      id: string;
      fence: number;
    } | null;
    expect(event).toMatchObject({
      id: `session:${sessionId}:1:1`,
      fence: 1,
    });
    await expect(client.zrange("tvic:v1:leases", 0, -1)).resolves.toEqual(["session%3Ainitial"]);
    client.nowMs = 1_200;
    await expect(
      store.leases.listRecoveryCandidates({ nowMs: client.nowMs, limit: 10 }),
    ).resolves.toEqual({ sessionIds: [sessionId] });
    await expect(store.sessions.get(sessionId)).resolves.toMatchObject({
      session: { id: sessionId, status: "active" },
    });
  });

  it("uses one request hash for idempotency conflicts", async () => {
    const client = new FakeRedis();
    const store = new RedisToolIdempotencyStore(client, { nowMs: () => 100 });
    const claim = await store.claim({
      key: "tool:key",
      requestHash: "hash_a",
      owner: "one",
      ttlMs: 1000,
    });
    expect(claim.status).toBe("claimed");
    expect(
      (await store.claim({ key: "tool:key", requestHash: "hash_b", owner: "two", ttlMs: 1000 }))
        .status,
    ).toBe("conflict");
  });

  it("migrates legacy idempotency errors when reading Redis", async () => {
    const client = new FakeRedis();
    const prefix = "legacy:";
    client.values.set(
      idempotencyKey(prefix, "legacy:key"),
      JSON.stringify({
        key: "legacy:key",
        requestHash: "hash",
        status: "failed",
        owner: "worker",
        expiresAtMs: 1_000,
        error: {
          code: "provider.failed",
          category: "provider",
          message: "legacy provider failure",
          retriable: true,
        },
      }),
    );

    const store = new RedisToolIdempotencyStore(client, { prefix });
    await expect(store.lookup("legacy:key", "hash")).resolves.toMatchObject({
      error: {
        name: "ProviderError",
        category: "provider",
        code: "provider.failed",
      },
    });
  });

  it("requires the claiming owner for terminal idempotency completion", async () => {
    const client = new FakeRedis();
    const store = new RedisToolIdempotencyStore(client, { nowMs: () => 100 });
    await store.claim({ key: "tool:owner", requestHash: "hash", owner: "one", ttlMs: 1000 });
    await expect(
      store.complete("tool:owner", "hash", {
        status: "succeeded",
        owner: "two",
        output: { ok: true },
        ttlMs: 1000,
      }),
    ).rejects.toThrow(/conflict/i);
    await store.complete("tool:owner", "hash", {
      status: "succeeded",
      owner: "one",
      output: { ok: true },
      ttlMs: 1000,
    });
    await expect(
      store.complete("tool:owner", "hash", {
        status: "succeeded",
        owner: "one",
        output: { ok: true },
        ttlMs: 1000,
      }),
    ).resolves.toBeUndefined();
  });

  it("fences idempotency claims and lets the next session fence reclaim a stale claim", async () => {
    const client = new FakeRedis();
    const leases = new RedisSessionLeaseStore(client, { nowMs: () => client.nowMs });
    const store = new RedisToolIdempotencyStore(client, { nowMs: () => client.nowMs });
    const first = await leases.acquire("session_fenced" as SessionId, "holder_one", 1_000);
    expect(first).not.toBeNull();
    const firstLease = first!;
    await expect(
      store.claim({
        key: "fenced:key",
        requestHash: "hash",
        owner: "tool_one",
        ttlMs: 10_000,
        lease: firstLease,
      }),
    ).resolves.toMatchObject({ status: "claimed", record: { claimedFence: 1 } });

    client.nowMs = 1_200;
    const second = await leases.acquire("session_fenced" as SessionId, "holder_two", 1_000);
    expect(second?.fence).toBe(2);
    await expect(
      store.claim({
        key: "fenced:key",
        requestHash: "hash",
        owner: "tool_two",
        ttlMs: 10_000,
        lease: second!,
      }),
    ).resolves.toMatchObject({ status: "claimed", record: { owner: "tool_two", claimedFence: 2 } });
    await expect(
      store.complete("fenced:key", "hash", {
        status: "succeeded",
        owner: "tool_two",
        ttlMs: 1_000,
        output: { missingLease: true },
      }),
    ).rejects.toMatchObject({ code: "LEASE_LOST" });
    await expect(
      store.complete("fenced:key", "hash", {
        status: "succeeded",
        owner: "tool_one",
        ttlMs: 1_000,
        lease: firstLease,
        output: { stale: true },
      }),
    ).rejects.toMatchObject({ code: "LEASE_LOST" });
    await expect(
      store.complete("fenced:key", "hash", {
        status: "succeeded",
        owner: "tool_two",
        ttlMs: 1_000,
        lease: second!,
        output: { ok: true },
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects an older outbox cache event after a newer one", async () => {
    const client = new FakeRedis();
    const projector = new RedisOutboxCacheProjector(client);
    const makeEvent = (version: number): DurableOutboxEvent => ({
      id: `session:cache:${version}`,
      aggregateType: "session",
      aggregateId: "session_cache" as SessionId,
      sessionId: "session_cache" as SessionId,
      version,
      fence: 4,
      envelope: {
        kind: "session",
        schemaVersion: 1,
        payload: {
          id: "session_cache",
          agentId: "agent_cache",
          status: "active",
          channel: "simulated",
          memoryRefs: [],
          createdAt: "2026-05-20T00:00:00.000Z" as Timestamp,
          startedAt: "2026-05-20T00:00:00.000Z" as Timestamp,
          state: { variables: {}, pendingToolCallIds: [], turnSequence: 0 },
        },
        runtime: { monotonicStartedAtMs: version },
        version,
      },
    });
    await projector.apply(makeEvent(2));
    await projector.apply(makeEvent(1));
    expect(client.values.get("tvic:v1:session:session_cache")).toContain('"version":2');
  });
});
