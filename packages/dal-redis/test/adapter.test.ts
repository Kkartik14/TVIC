import { describe, expect, it } from "vitest";
import type {
  DurableOutboxEvent,
  SessionId,
  StoredSessionRecord,
  Timestamp,
  ToolId,
} from "@tvic/core";
import { LeaseLostError, toolError } from "@tvic/core";

import {
  RedisDurableRuntimeStore,
  RedisSessionLeaseStore,
  RedisOutboxCacheProjector,
  RedisToolIdempotencyStore,
  type RedisClient,
  type RedisMulti,
} from "../src/index.js";
import { idempotencyKey, leaseKey } from "../src/keys.js";

class FakeRedis implements RedisClient {
  readonly values = new Map<string, string>();
  readonly expiresAt = new Map<string, number>();
  readonly sorted = new Map<string, Map<string, number>>();
  nowMs = 100;

  async get(key: string): Promise<string | null> {
    if ((this.expiresAt.get(key) ?? Number.POSITIVE_INFINITY) <= this.nowMs) {
      this.values.delete(key);
      this.expiresAt.delete(key);
      return null;
    }
    return this.values.get(key) ?? null;
  }

  async set(
    key: string,
    value: string,
    options?: { readonly NX?: boolean; readonly PX?: number },
  ): Promise<"OK" | null> {
    if (options?.NX && this.values.has(key)) return null;
    this.values.set(key, value);
    if (options?.PX !== undefined) this.expiresAt.set(key, this.nowMs + options.PX);
    else this.expiresAt.delete(key);
    return "OK";
  }

  async del(...keys: readonly string[]): Promise<number> {
    return keys.reduce((count, key) => {
      const deleted = this.values.delete(key);
      this.expiresAt.delete(key);
      this.sorted.delete(key);
      return count + (deleted ? 1 : 0);
    }, 0);
  }

  async eval(script: string, keys: readonly string[], args: readonly string[]): Promise<unknown> {
    if (script.includes("TVIC_QUARANTINE_RECOVERED_IDEMPOTENCY")) {
      const leaseRaw = this.values.get(keys[0]!);
      if (!leaseRaw) return [-1, ""];
      const lease = JSON.parse(leaseRaw) as {
        holder: string;
        fence: number;
        generationId?: string;
        acquiredAtMs?: number;
        expiresAtMs: number;
      };
      const generationId = lease.generationId ?? `legacy:${lease.fence}:${lease.acquiredAtMs ?? 0}`;
      if (
        lease.holder !== args[0] ||
        lease.fence !== Number(args[1]) ||
        generationId !== args[2] ||
        lease.expiresAtMs <= this.nowMs
      ) {
        return [-1, ""];
      }
      const currentRaw = await this.get(keys[1]!);
      if (currentRaw) {
        const current = JSON.parse(currentRaw) as Record<string, unknown>;
        if (Number(current.expiresAtMs) > this.nowMs) {
          if (
            current.sessionId !== args[4] ||
            current.toolId !== args[5] ||
            current.toolVersion !== args[6] ||
            current.requestHash !== args[7]
          ) {
            return [-2, currentRaw];
          }
          if (current.status === "succeeded") return [2, currentRaw];
          if (current.status !== "claimed") return [3, currentRaw];
          if (current.owner !== args[8]) return [0, currentRaw];
          const priorLease =
            current.claimedGenerationId !== undefined
              ? current.claimedGenerationId !== args[2] &&
                (current.claimedFence === undefined ||
                  Number(current.claimedFence) < Number(args[1]))
              : current.claimedFence !== undefined &&
                Number(current.claimedFence) < Number(args[1]);
          if (!priorLease) return [0, currentRaw];
        }
      }
      const record = {
        key: args[3],
        sessionId: args[4],
        toolId: args[5],
        toolVersion: args[6],
        requestHash: args[7],
        status: "failed",
        owner: args[8],
        claimedFence: Number(args[1]),
        claimedGenerationId: args[2],
        expiresAtMs: this.nowMs + Number(args[9]),
        error: JSON.parse(args[10]!),
      };
      const encoded = JSON.stringify(record);
      this.values.set(keys[1]!, encoded);
      this.expiresAt.set(keys[1]!, this.nowMs + Number(args[9]));
      return [1, encoded];
    }
    if (script.includes("TVIC_DELETE_EXPIRED_IDEMPOTENCY")) {
      const raw = this.values.get(keys[0]!);
      if (!raw) return 0;
      const record = JSON.parse(raw) as { expiresAtMs?: number };
      if (typeof record.expiresAtMs === "number" && record.expiresAtMs <= this.nowMs) {
        this.values.delete(keys[0]!);
        this.expiresAt.delete(keys[0]!);
        return 1;
      }
      return 0;
    }
    if (script.includes("if current then return 0 end")) {
      if (this.values.has(keys[0]!)) return 0;
      this.values.set(keys[0]!, args[0]!);
      this.zadd(keys[1]!, Number(args[1]), keys[0]!);
      return 1;
    }
    if (script.includes("current.recoveryResolvedGenerationId = generationId")) {
      const raw = this.values.get(keys[0]!);
      if (!raw) return 0;
      const lease = JSON.parse(raw) as {
        sessionId: string;
        fence: number;
        generationId?: string;
        acquiredAtMs?: number;
        expiresAtMs: number;
        recoveryResolvedGenerationId?: string;
        recoveryResolvedFence?: number;
      };
      const generationId = lease.generationId ?? `legacy:${lease.fence}:${lease.acquiredAtMs ?? 0}`;
      if (
        lease.sessionId !== args[0] ||
        lease.fence !== Number(args[1]) ||
        generationId !== args[2] ||
        lease.expiresAtMs > this.nowMs
      ) {
        return 0;
      }
      lease.recoveryResolvedGenerationId = generationId;
      this.values.set(keys[0]!, JSON.stringify(lease));
      this.zrem(keys[1]!, args[3]!);
      this.zrem(keys[2]!, args[0]!);
      return 1;
    }
    if (script.includes("TVIC_BOUNDED_RECOVERY_PAGE")) {
      const cursorProvided = args[0] === "1";
      const cursor = args[1]!;
      const limit = Number(args[2]);
      const leasePrefix = args[3]!;
      const due = [...(this.sorted.get(keys[0]!)?.entries() ?? [])]
        .filter(([, score]) => score <= this.nowMs)
        .sort(
          ([aMember, aScore], [bMember, bScore]) =>
            aScore - bScore || aMember.localeCompare(bMember),
        )
        .map(([member]) => member)
        .slice(0, limit + 1);
      for (const member of due.slice(0, limit)) {
        this.zrem(keys[0]!, member);
        const raw = this.values.get(`${leasePrefix}${member}`);
        if (!raw) continue;
        const lease = JSON.parse(raw) as {
          sessionId?: unknown;
          expiresAtMs?: unknown;
          fence?: number;
          generationId?: string;
          acquiredAtMs?: number;
          recoveryResolvedGenerationId?: string;
          recoveryResolvedFence?: number;
        };
        const sessionId = decodeURIComponent(member);
        const expiresAtMs = Number(lease.expiresAtMs);
        if (lease.sessionId !== sessionId || !Number.isFinite(expiresAtMs)) continue;
        const generationId =
          lease.generationId ?? `legacy:${lease.fence}:${lease.acquiredAtMs ?? 0}`;
        if (
          lease.recoveryResolvedGenerationId === generationId ||
          lease.recoveryResolvedFence === lease.fence
        )
          this.zrem(keys[1]!, sessionId);
        else if (expiresAtMs <= this.nowMs) this.zadd(keys[1]!, 0, sessionId);
        else this.zadd(keys[0]!, expiresAtMs, member);
      }
      const ids = [...(this.sorted.get(keys[1]!)?.keys() ?? [])].sort();
      const afterCursor = cursorProvided ? ids.filter((id) => id > cursor) : ids;
      const members = afterCursor.slice(0, limit + 1);
      const inspected = Math.min(members.length, limit);
      const candidateIds: string[] = [];
      const candidateFences: number[] = [];
      const candidateGenerationIds: string[] = [];
      for (const sessionId of members.slice(0, inspected)) {
        const raw = this.values.get(`${leasePrefix}${encodeURIComponent(sessionId)}`);
        const lease = raw
          ? (JSON.parse(raw) as {
              sessionId?: unknown;
              expiresAtMs?: unknown;
              fence?: number;
              generationId?: string;
              acquiredAtMs?: number;
              recoveryResolvedGenerationId?: string;
              recoveryResolvedFence?: number;
            })
          : undefined;
        const expiresAtMs = Number(lease?.expiresAtMs);
        if (
          lease?.sessionId === sessionId &&
          Number.isFinite(expiresAtMs) &&
          expiresAtMs <= this.nowMs
        ) {
          const generationId =
            lease.generationId ?? `legacy:${lease.fence}:${lease.acquiredAtMs ?? 0}`;
          if (
            lease.recoveryResolvedGenerationId === generationId ||
            lease.recoveryResolvedFence === lease.fence
          ) {
            this.zrem(keys[1]!, sessionId);
          } else if (Number.isSafeInteger(lease.fence)) {
            candidateIds.push(sessionId);
            candidateFences.push(lease.fence!);
            candidateGenerationIds.push(generationId);
          }
        } else {
          this.zrem(keys[1]!, sessionId);
          if (lease?.sessionId === sessionId && Number.isFinite(expiresAtMs)) {
            this.zadd(keys[0]!, expiresAtMs, encodeURIComponent(sessionId));
          }
        }
      }
      return [
        candidateIds,
        candidateFences,
        candidateGenerationIds,
        members[inspected - 1] ?? "",
        members.length > limit ? 1 : 0,
        inspected,
        due.length > limit ? 1 : 0,
      ];
    }
    if (script.includes("if not current or current ~= ARGV[1]")) {
      const current = this.values.get(keys[0]!);
      if (!current || current !== args[0]) return 0;
      this.values.set(keys[0]!, args[1]!);
      return 1;
    }
    if (script.includes("redis.call('SET', ARGV[6], ARGV[5])")) {
      const rawLease = this.values.get(keys[2]!);
      if (!rawLease) return 0;
      const lease = JSON.parse(rawLease) as {
        holder: string;
        fence: number;
        generationId?: string;
        acquiredAtMs?: number;
        expiresAtMs: number;
      };
      const generationId = lease.generationId ?? `legacy:${lease.fence}:${lease.acquiredAtMs ?? 0}`;
      if (
        lease.holder !== args[1] ||
        lease.fence !== Number(args[3]) ||
        generationId !== args[8] ||
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
        if (current.holder !== args[1]) return 0;
        this.zadd(keys[3]!, current.expiresAtMs, args[4]!);
        this.zrem(keys[4]!, args[2]!);
        return rawLease;
      }
      const lease = {
        sessionId: args[2],
        holder: args[1],
        fence: (current?.fence ?? 0) + 1,
        generationId: args[5],
        acquiredAtMs: this.nowMs,
        renewedAtMs: this.nowMs,
        expiresAtMs: this.nowMs + Number(args[3]),
      };
      const encoded = JSON.stringify(lease);
      this.values.set(keys[2]!, encoded);
      this.zadd(keys[3]!, lease.expiresAtMs, args[4]!);
      this.zrem(keys[4]!, args[2]!);
      return encoded;
    }
    if (script.includes("next.sessionId = ARGV[4]")) {
      const rawLease = this.values.get(keys[0]!);
      if (!rawLease) return [-1, ""];
      const lease = JSON.parse(rawLease) as {
        holder: string;
        fence: number;
        generationId?: string;
        acquiredAtMs?: number;
        expiresAtMs: number;
      };
      const generationId = lease.generationId ?? `legacy:${lease.fence}:${lease.acquiredAtMs ?? 0}`;
      if (
        lease.holder !== args[0] ||
        lease.fence !== Number(args[1]) ||
        generationId !== args[9] ||
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
          claimedGenerationId?: string;
          expiresAtMs: number;
        };
        if (current.expiresAtMs > this.nowMs) {
          if (
            (args[4] && current.toolId && args[4] !== current.toolId) ||
            (args[5] && current.toolVersion && args[5] !== current.toolVersion) ||
            current.requestHash !== args[6] ||
            (args[3] && current.sessionId !== args[3])
          ) {
            return [-2, currentRaw];
          }
          if (current.status === "succeeded") return [2, currentRaw];
          if (current.status !== "claimed") return [3, currentRaw];
          if (current.status === "claimed") {
            const sameSession = Boolean(args[3]) && current.sessionId === args[3];
            const stale =
              sameSession &&
              (current.claimedGenerationId !== undefined
                ? current.claimedGenerationId !== args[9] ||
                  (current.claimedFence !== undefined && current.claimedFence < Number(args[1]))
                : current.claimedFence !== undefined && current.claimedFence < Number(args[1]));
            if (!stale) return [0, currentRaw];
          }
        }
      }
      const record = {
        key: args[2],
        ...(args[3]
          ? {
              sessionId: args[3],
              claimedFence: Number(args[1]),
              claimedGenerationId: args[9],
            }
          : {}),
        ...(args[4] ? { toolId: args[4] } : {}),
        ...(args[5] ? { toolVersion: args[5] } : {}),
        requestHash: args[6],
        status: "claimed",
        owner: args[7],
        expiresAtMs: this.nowMs + Number(args[8]),
      };
      const encoded = JSON.stringify(record);
      this.values.set(keys[1]!, encoded);
      this.expiresAt.set(keys[1]!, this.nowMs + Number(args[8]));
      return [1, encoded];
    }
    if (script.includes("current.status = ARGV[5]")) {
      const rawLease = this.values.get(keys[0]!);
      const rawCurrent = this.values.get(keys[1]!);
      if (!rawLease) return [-1, ""];
      const lease = JSON.parse(rawLease) as {
        holder: string;
        fence: number;
        generationId?: string;
        acquiredAtMs?: number;
        expiresAtMs: number;
      };
      const generationId = lease.generationId ?? `legacy:${lease.fence}:${lease.acquiredAtMs ?? 0}`;
      if (
        lease.holder !== args[0] ||
        lease.fence !== Number(args[1]) ||
        generationId !== args[9] ||
        lease.expiresAtMs <= this.nowMs
      ) {
        return [-1, ""];
      }
      if (!rawCurrent) return [-2, ""];
      const current = JSON.parse(rawCurrent) as {
        requestHash: string;
        owner: string;
        sessionId: string;
        status: string;
        expiresAtMs: number;
        claimedFence?: number;
        claimedGenerationId?: string;
        output?: unknown;
        error?: unknown;
      };
      if (
        current.expiresAtMs <= this.nowMs ||
        current.requestHash !== args[2] ||
        current.owner !== args[3] ||
        (current.sessionId !== undefined && current.sessionId !== args[8]) ||
        current.claimedGenerationId !== args[9]
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
      this.expiresAt.set(keys[1]!, this.nowMs + Number(args[5]));
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
    if (script.includes("local arg = 4")) {
      const rawLease = this.values.get(keys[0]!);
      if (!rawLease) return 0;
      const lease = JSON.parse(rawLease) as {
        holder: string;
        fence: number;
        generationId?: string;
        acquiredAtMs?: number;
        expiresAtMs: number;
      };
      const generationId = lease.generationId ?? `legacy:${lease.fence}:${lease.acquiredAtMs ?? 0}`;
      if (
        lease.holder !== args[0] ||
        lease.fence !== Number(args[1]) ||
        generationId !== args[2] ||
        lease.expiresAtMs <= this.nowMs
      ) {
        return 0;
      }
      for (let index = 1; index < keys.length; index += 1) {
        const value = args[3 + (index - 1) * 4]!;
        const indexKey = args[4 + (index - 1) * 4]!;
        const score = Number(args[5 + (index - 1) * 4]);
        const expected = args[6 + (index - 1) * 4]!;
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
        if (current.holder !== args[0]) return "";
        this.zadd(keys[1]!, current.expiresAtMs, args[3]!);
        this.zrem(keys[2]!, args[1]!);
        return currentRaw;
      }
      const lease = {
        sessionId: args[1],
        holder: args[0],
        fence: (current?.fence ?? 0) + 1,
        generationId: args[4],
        acquiredAtMs: this.nowMs,
        renewedAtMs: this.nowMs,
        expiresAtMs: this.nowMs + Number(args[2]),
      };
      const encoded = JSON.stringify(lease);
      this.values.set(keys[0]!, encoded);
      this.zadd(keys[1]!, lease.expiresAtMs, args[3]!);
      this.zrem(keys[2]!, args[1]!);
      return encoded;
    }
    if (script.includes("current.expiresAtMs = now")) {
      const raw = this.values.get(keys[0]!);
      if (!raw) return 0;
      const lease = JSON.parse(raw) as { holder: string; fence: number } & Record<string, unknown>;
      const generationId =
        typeof lease.generationId === "string"
          ? lease.generationId
          : `legacy:${lease.fence}:${lease.acquiredAtMs}`;
      if (lease.holder !== args[0] || lease.fence !== Number(args[1]) || generationId !== args[4])
        return 0;
      lease.renewedAtMs = this.nowMs;
      lease.expiresAtMs = this.nowMs;
      this.values.set(keys[0]!, JSON.stringify(lease));
      this.zrem(keys[2]!, args[3]!);
      if (
        lease.recoveryResolvedGenerationId === generationId ||
        lease.recoveryResolvedFence === lease.fence
      )
        this.zrem(keys[1]!, args[2]!);
      else this.zadd(keys[1]!, this.nowMs, args[2]!);
      return 1;
    }
    if (script.includes("current.renewedAtMs = now")) {
      const raw = this.values.get(keys[0]!);
      if (!raw) return "";
      const lease = JSON.parse(raw) as {
        sessionId: string;
        holder: string;
        fence: number;
        generationId?: string;
        acquiredAtMs?: number;
        expiresAtMs: number;
        renewedAtMs: number;
      };
      const generationId = lease.generationId ?? `legacy:${lease.fence}:${lease.acquiredAtMs ?? 0}`;
      if (
        lease.holder !== args[0] ||
        lease.fence !== Number(args[1]) ||
        generationId !== args[4] ||
        lease.expiresAtMs <= this.nowMs
      ) {
        return "";
      }
      lease.renewedAtMs = this.nowMs;
      lease.expiresAtMs = this.nowMs + Number(args[2]);
      delete (lease as { recoveryResolvedFence?: number }).recoveryResolvedFence;
      const encoded = JSON.stringify(lease);
      this.values.set(keys[0]!, encoded);
      this.zadd(keys[1]!, lease.expiresAtMs, args[3]!);
      this.zrem(keys[2]!, lease.sessionId);
      return encoded;
    }
    throw new Error("FakeRedis does not recognize this script");
  }

  async scan(
    cursor = "0",
    options?: { readonly MATCH?: string; readonly COUNT?: number },
  ): Promise<readonly [string, readonly string[]]> {
    const pattern = options?.MATCH?.endsWith("*") ? options.MATCH.slice(0, -1) : undefined;
    const keys = [...this.values.keys()].filter((key) => !pattern || key.startsWith(pattern));
    const start = Number(cursor) || 0;
    const end = Math.min(keys.length, start + (options?.COUNT ?? keys.length));
    return [end >= keys.length ? "0" : String(end), keys.slice(start, end)];
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
      set: (key, value, options) => {
        commands.push(() => this.set(key, value, options));
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
      set: (key, value, options) => {
        commands.push(() => this.set(key, value, options));
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

  private zrem(key: string, member: string): void {
    this.sorted.get(key)?.delete(member);
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

  it("continues through staged recovery candidates with an opaque cursor", async () => {
    const client = new FakeRedis();
    const leases = new RedisSessionLeaseStore(client);
    await leases.acquire("z_session" as SessionId, "holder_z", 100);
    await leases.acquire("a_session" as SessionId, "holder_a", 100);
    client.nowMs = 500;

    const first = await leases.listRecoveryCandidates({ nowMs: 500, limit: 1 });
    expect(first.candidates).toMatchObject([{ sessionId: "a_session", fence: 1 }]);
    expect(first.candidates[0]?.generationId).toEqual(expect.any(String));
    expect(first.nextCursor).toBeDefined();
    await expect(
      leases.listRecoveryCandidates({ nowMs: 500, limit: 1, cursor: first.nextCursor! }),
    ).resolves.toMatchObject({ candidates: [{ sessionId: "z_session", fence: 1 }] });
  });

  it("acknowledges only the expired lease generation returned by a page", async () => {
    const client = new FakeRedis();
    const leases = new RedisSessionLeaseStore(client);
    const sessionId = "session_recovery_ack" as SessionId;
    await leases.acquire(sessionId, "holder_a", 10);
    client.nowMs = 200;
    const first = await leases.listRecoveryCandidates({ nowMs: client.nowMs, limit: 10 });
    expect(first.candidates).toMatchObject([{ sessionId, fence: 1 }]);
    expect(first.candidates[0]?.generationId).toEqual(expect.any(String));

    await leases.acknowledgeRecoveryCandidate(first.candidates[0]!);
    await expect(
      leases.listRecoveryCandidates({ nowMs: client.nowMs, limit: 10 }),
    ).resolves.toEqual({ candidates: [] });

    expect((await leases.acquire(sessionId, "holder_b", 10))?.fence).toBe(2);
    client.nowMs = 300;
    const second = await leases.listRecoveryCandidates({ nowMs: client.nowMs, limit: 10 });
    expect(second.candidates).toMatchObject([{ sessionId, fence: 2 }]);
    expect(second.candidates[0]?.generationId).not.toBe(first.candidates[0]?.generationId);
    await leases.acknowledgeRecoveryCandidate(first.candidates[0]!);
    await expect(
      leases.listRecoveryCandidates({ nowMs: client.nowMs, limit: 10 }),
    ).resolves.toMatchObject({ candidates: [{ sessionId, fence: 2 }] });
  });

  it("fences stale transactions when a deleted lease restarts its numeric fence", async () => {
    const client = new FakeRedis();
    const store = new RedisDurableRuntimeStore(client);
    const sessionId = "session_generation_reuse" as SessionId;
    const record: StoredSessionRecord = {
      session: {
        id: sessionId,
        agentId: "agent_generation_reuse" as never,
        status: "active",
        channel: "simulated",
        memoryRefs: [],
        createdAt: "2026-08-29T00:00:00.000Z" as Timestamp,
        startedAt: "2026-08-29T00:00:00.000Z" as Timestamp,
        state: { variables: {}, pendingToolCallIds: [], turnSequence: 0 },
      },
      runtime: { monotonicStartedAtMs: 1 },
    };
    await store.sessions.put(record);
    const oldLease = await store.leases.acquire(sessionId, "same_holder", 1_000);
    expect(oldLease?.fence).toBe(1);

    await client.del(leaseKey(undefined, sessionId));
    const replacement = await store.leases.acquire(sessionId, "same_holder", 1_000);
    expect(replacement?.fence).toBe(oldLease?.fence);
    expect(replacement?.generationId).not.toBe(oldLease?.generationId);
    expect(
      await store.leases.renew(
        sessionId,
        "same_holder",
        oldLease!.fence,
        1_000,
        oldLease!.generationId,
      ),
    ).toBeNull();
    await store.leases.release(sessionId, "same_holder", oldLease!.fence, oldLease!.generationId);
    await expect(store.leases.get(sessionId)).resolves.toMatchObject({
      generationId: replacement?.generationId,
    });
    await expect(
      store.runSessionTransaction(sessionId, oldLease!, async () => undefined),
    ).rejects.toBeInstanceOf(LeaseLostError);
  });

  it("advances bounded recovery pages across active leases and lease score changes", async () => {
    const client = new FakeRedis();
    const leases = new RedisSessionLeaseStore(client);
    const activeId = "a_active" as SessionId;
    const expiringId = "b_expired" as SessionId;
    const laterId = "z_later" as SessionId;
    await leases.acquire(activeId, "holder_a", 1_000);
    await leases.acquire(expiringId, "holder_b", 10);
    await leases.acquire(laterId, "holder_c", 20);
    client.nowMs = 200;

    const first = await leases.listRecoveryCandidates({ nowMs: 200, limit: 1 });
    expect(first.candidates).toMatchObject([{ sessionId: expiringId, fence: 1 }]);
    expect(first.nextCursor).toBeDefined();

    const renewed = await leases.acquire(expiringId, "holder_b_reacquired", 1_000);
    expect(renewed?.fence).toBe(2);
    const second = await leases.listRecoveryCandidates({
      nowMs: 200,
      limit: 1,
      cursor: first.nextCursor!,
    });
    expect(second.candidates).toMatchObject([{ sessionId: laterId, fence: 1 }]);
    expect(second.nextCursor).toBeUndefined();
  });

  it("recovers expired leases already present in the legacy expiry index", async () => {
    const client = new FakeRedis();
    const leases = new RedisSessionLeaseStore(client);
    await leases.acquire("legacy_session" as SessionId, "legacy_holder", 10);
    client.nowMs = 200;

    await expect(leases.listRecoveryCandidates({ nowMs: 200, limit: 10 })).resolves.toMatchObject({
      candidates: [{ sessionId: "legacy_session", fence: 1 }],
    });
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
    expect(lease?.generationId).toEqual(expect.any(String));
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
    ).resolves.toMatchObject({
      candidates: [{ sessionId, fence: 1, generationId: lease?.generationId }],
    });
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
    await expect(
      store.claim({ key: "tool:key", requestHash: "hash_a", owner: "one", ttlMs: 1000 }),
    ).resolves.toMatchObject({ status: "in_progress", record: { owner: "one" } });
    expect(
      (await store.claim({ key: "tool:key", requestHash: "hash_b", owner: "two", ttlMs: 1000 }))
        .status,
    ).toBe("conflict");
  });

  it("does not return a fenced idempotency result to another session", async () => {
    const client = new FakeRedis();
    const leases = new RedisSessionLeaseStore(client, { nowMs: () => client.nowMs });
    const store = new RedisToolIdempotencyStore(client, { nowMs: () => client.nowMs });
    const sessionA = "idempotency_session_a" as SessionId;
    const sessionB = "idempotency_session_b" as SessionId;
    const leaseA = await leases.acquire(sessionA, "holder_a", 10_000);
    const leaseB = await leases.acquire(sessionB, "holder_b", 10_000);
    expect(leaseA).not.toBeNull();
    expect(leaseB).not.toBeNull();
    await store.claim({
      key: "shared-key",
      requestHash: "same-hash",
      owner: "owner_a",
      ttlMs: 1_000,
      lease: leaseA!,
    });
    await store.complete("shared-key", "same-hash", {
      status: "succeeded",
      owner: "owner_a",
      output: { tenant: "A" },
      ttlMs: 1_000,
      lease: leaseA!,
    });
    await expect(
      store.complete("shared-key", "same-hash", {
        status: "succeeded",
        owner: "owner_a",
        output: { tenant: "B" },
        ttlMs: 1_000,
        lease: leaseB!,
      }),
    ).rejects.toThrow();

    const crossSession = await store.claim({
      key: "shared-key",
      requestHash: "same-hash",
      owner: "owner_b",
      ttlMs: 1_000,
      lease: leaseB!,
    });
    expect(crossSession).toMatchObject({ status: "conflict" });
    await expect(store.lookup("shared-key", "different-hash", sessionA)).resolves.toEqual({
      status: "conflict",
    });
    await expect(store.lookup("shared-key", "same-hash", sessionB)).resolves.toEqual({
      status: "conflict",
    });
    await expect(
      store.claim({ key: "shared-key", requestHash: "same-hash", owner: "unfenced", ttlMs: 1_000 }),
    ).resolves.toEqual({ status: "conflict" });
  });

  it("does not re-run a pre-generation idempotency claim at the same fence", async () => {
    const client = new FakeRedis();
    const sessionId = "legacy_idempotency_session" as SessionId;
    const lease = await new RedisSessionLeaseStore(client).acquire(
      sessionId,
      "current_holder",
      1_000,
    );
    const key = "legacy-generation-claim";
    client.values.set(
      idempotencyKey(undefined, key),
      JSON.stringify({
        key,
        sessionId,
        claimedFence: lease!.fence,
        requestHash: "same-request",
        status: "claimed",
        owner: "old-owner",
        expiresAtMs: 900,
      }),
    );

    await expect(
      new RedisToolIdempotencyStore(client, { nowMs: () => client.nowMs }).claim({
        key,
        requestHash: "same-request",
        owner: "new-owner",
        ttlMs: 1_000,
        lease: {
          sessionId,
          holder: lease!.holder,
          fence: lease!.fence,
          generationId: lease!.generationId,
        },
      }),
    ).resolves.toMatchObject({ status: "in_progress", record: { owner: "old-owner" } });
    await expect(
      new RedisToolIdempotencyStore(client, { nowMs: () => client.nowMs }).claim({
        key,
        requestHash: "same-request",
        owner: "old-owner",
        ttlMs: 1_000,
        lease: {
          sessionId,
          holder: lease!.holder,
          fence: lease!.fence,
          generationId: lease!.generationId,
        },
      }),
    ).resolves.toMatchObject({ status: "in_progress", record: { owner: "old-owner" } });
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
      status: "found",
      record: {
        error: {
          name: "ProviderError",
          category: "provider",
          code: "provider.failed",
        },
      },
    });
  });

  it("does not overwrite a newer Redis record during an alias rewrite", async () => {
    class RacingRedis extends FakeRedis {
      override async eval(
        script: string,
        keys: readonly string[],
        args: readonly string[],
      ): Promise<unknown> {
        if (script.includes("if not current or current ~= ARGV[1]")) {
          this.values.set(
            keys[0]!,
            JSON.stringify({
              key: "legacy:racing",
              requestHash: "hash",
              status: "succeeded",
              owner: "worker-2",
              expiresAtMs: 2_000,
              output: { completed: true },
            }),
          );
        }
        return super.eval(script, keys, args);
      }
    }

    const client = new RacingRedis();
    const prefix = "legacy-racing:";
    client.values.set(
      idempotencyKey(prefix, "legacy:racing"),
      JSON.stringify({
        key: "legacy:racing",
        requestHash: "hash",
        status: "failed",
        owner: "worker-1",
        expiresAtMs: 1_000,
        error: {
          code: "stt.provider.auth_failed",
          category: "provider",
          message: "legacy provider failure",
          retriable: true,
        },
      }),
    );

    const diagnostics: unknown[] = [];
    const store = new RedisToolIdempotencyStore(client, {
      prefix,
      onCompatibilityDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    await expect(store.lookup("legacy:racing", "hash")).resolves.toMatchObject({
      status: "found",
      record: { error: { code: "provider.auth_failed" } },
    });
    expect(JSON.parse(client.values.get(idempotencyKey(prefix, "legacy:racing"))!)).toMatchObject({
      status: "succeeded",
      output: { completed: true },
    });
    expect(diagnostics).toEqual([
      expect.objectContaining({
        adapter: "redis",
        operation: "idempotency_alias_rewrite",
        legacyCode: "stt.provider.auth_failed",
        canonicalCode: "provider.auth_failed",
        outcome: "rewrite_failed",
      }),
    ]);
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

  it("sets physical TTLs and never reclaims a stored failed outcome", async () => {
    const client = new FakeRedis();
    const store = new RedisToolIdempotencyStore(client, { nowMs: () => client.nowMs });
    const key = "terminal:failed";
    const redisKey = idempotencyKey(undefined, key);
    await expect(
      store.claim({ key, requestHash: "request", owner: "owner", ttlMs: 1_000 }),
    ).resolves.toMatchObject({ status: "claimed" });
    expect(client.expiresAt.get(redisKey)).toBe(1_100);
    await store.complete(key, "request", {
      status: "failed",
      owner: "owner",
      ttlMs: 500,
      error: toolError("tool.execution_failed", "Tool execution failed", { retriable: false }),
    });
    expect(client.expiresAt.get(redisKey)).toBe(600);
    await expect(
      store.claim({ key, requestHash: "request", owner: "retry", ttlMs: 1_000 }),
    ).resolves.toMatchObject({ status: "terminal", record: { status: "failed" } });

    client.nowMs = 600;
    await expect(store.lookup(key, "request")).resolves.toEqual({ status: "missing" });
    expect(client.values.has(redisKey)).toBe(false);
  });

  it("prunes expired legacy rows using bounded Redis scan pages", async () => {
    const client = new FakeRedis();
    const prefix = "legacy-cleanup:";
    const store = new RedisToolIdempotencyStore(client, { prefix });
    const redisKey = idempotencyKey(prefix, "expired-legacy");
    client.values.set(
      redisKey,
      JSON.stringify({
        key: "expired-legacy",
        requestHash: "legacy-request",
        status: "succeeded",
        expiresAtMs: 99,
        output: { ok: true },
      }),
    );

    await expect(store.pruneExpiredIdempotencyPage("0", 10)).resolves.toMatchObject({
      cursor: "0",
      scanned: 1,
      deleted: 1,
    });
    expect(client.values.has(redisKey)).toBe(false);
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

  it("atomically quarantines only the recovered idempotency owner", async () => {
    const client = new FakeRedis();
    const leases = new RedisSessionLeaseStore(client, { nowMs: () => client.nowMs });
    const store = new RedisToolIdempotencyStore(client, { nowMs: () => client.nowMs });
    const sessionId = "recovered_idempotency_session" as SessionId;
    const firstLease = await leases.acquire(sessionId, "recovery_holder", 10_000);
    expect(firstLease).not.toBeNull();
    const toolId = "recovered_tool" as ToolId;
    const identity = {
      key: "recovered-key",
      requestHash: "recovered-hash",
      sessionId,
      toolId,
      toolVersion: "1.0.0",
      ttlMs: 5_000,
      lease: firstLease!,
    };

    await store.claim({ ...identity, owner: "recovered-call" });
    await expect(
      store.quarantine({
        ...identity,
        owner: "recovered-call",
        error: toolError("tool.runtime_restarted", "The interrupted call will not be replayed"),
      }),
    ).resolves.toMatchObject({ status: "in_progress", record: { status: "claimed" } });
    await leases.release(
      sessionId,
      firstLease!.holder,
      firstLease!.fence,
      firstLease!.generationId,
    );
    const lease = await leases.acquire(sessionId, "recovery_holder_next", 10_000);
    expect(lease?.fence).toBe(firstLease!.fence + 1);
    const recoveredIdentity = { ...identity, lease: lease! };
    await expect(
      store.quarantine({
        ...recoveredIdentity,
        owner: "recovered-call",
        error: toolError("tool.runtime_restarted", "The interrupted call will not be replayed"),
      }),
    ).resolves.toMatchObject({
      status: "quarantined",
      record: { status: "failed", owner: "recovered-call" },
    });
    await expect(store.claim({ ...recoveredIdentity, owner: "retry-call" })).resolves.toMatchObject(
      {
        status: "terminal",
        record: { status: "failed" },
      },
    );

    const legacyKey = "same-fence-legacy-key";
    client.values.set(
      idempotencyKey(undefined, legacyKey),
      JSON.stringify({
        ...recoveredIdentity,
        key: legacyKey,
        status: "claimed",
        owner: "legacy-call",
        claimedFence: firstLease!.fence,
        expiresAtMs: client.nowMs + 5_000,
      }),
    );
    await expect(
      store.quarantine({
        ...recoveredIdentity,
        key: legacyKey,
        owner: "legacy-call",
        error: toolError("tool.runtime_restarted", "The interrupted call will not be replayed"),
      }),
    ).resolves.toMatchObject({
      status: "quarantined",
      record: { status: "failed", owner: "legacy-call", claimedFence: lease!.fence },
    });

    const otherKey = "other-owner-key";
    await store.claim({ ...recoveredIdentity, key: otherKey, owner: "active-call" });
    await expect(
      store.quarantine({
        ...recoveredIdentity,
        key: otherKey,
        owner: "recovered-call",
        error: toolError("tool.runtime_restarted", "The interrupted call will not be replayed"),
      }),
    ).resolves.toMatchObject({ status: "in_progress", record: { owner: "active-call" } });
    await expect(store.lookup(otherKey, "recovered-hash", sessionId)).resolves.toMatchObject({
      status: "found",
      record: { status: "claimed", owner: "active-call" },
    });
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
