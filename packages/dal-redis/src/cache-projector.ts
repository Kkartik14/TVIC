import { decodeOutboxEnvelope, stableStringify } from "@tvic/dal-codec";
import { BackendUnavailableError, DurableError, type DurableOutboxEvent } from "@tvic/core";
import type { RedisClient, RedisStoreOptions } from "./index.js";
import { cacheEventIndexKey, cacheEventKey, cacheEventScore } from "./keys.js";

const APPLY_CACHE_EVENT_SCRIPT = `
local currentRaw = redis.call('GET', KEYS[3])
if currentRaw then
  local current = cjson.decode(currentRaw)
  local currentFence = tonumber(current.fence)
  local currentVersion = tonumber(current.version)
  local incomingFence = tonumber(ARGV[2])
  local incomingVersion = tonumber(ARGV[3])
  if currentFence > incomingFence or (currentFence == incomingFence and currentVersion >= incomingVersion) then
    return 0
  end
end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('SET', KEYS[3], cjson.encode({fence = tonumber(ARGV[2]), version = tonumber(ARGV[3])}))
redis.call('ZADD', KEYS[2], ARGV[4], KEYS[1])
return 1
`;

/**
 * Applies Postgres outbox events to Redis as a version/fence guarded cache.
 * Redis is intentionally not a second runtime authority: a cache event can be
 * replayed, duplicated, or delivered out of order without replacing a newer
 * value. Postgres remains the source of truth and the outbox worker supplies
 * the retry boundary.
 */
export class RedisOutboxCacheProjector {
  constructor(
    readonly client: RedisClient,
    readonly options: RedisStoreOptions = {},
  ) {}

  async apply(event: DurableOutboxEvent): Promise<void> {
    try {
      const key = cacheEventKey(this.options.prefix, event);
      const indexKey = cacheEventIndexKey(this.options.prefix, event);
      const envelope = decodeOutboxEnvelope(
        event.aggregateType,
        event.envelope,
        `outbox:${event.id}`,
        event.version,
      );
      const score = cacheEventScore(event.aggregateType, envelope.payload);
      const encoded = stableStringify(envelope);
      await this.client.eval(
        APPLY_CACHE_EVENT_SCRIPT,
        [key, indexKey, `${key}:cache_meta`],
        [encoded, String(event.fence), String(event.version), String(score)],
      );
    } catch (error) {
      if (error instanceof DurableError) throw error;
      throw new BackendUnavailableError(
        `Redis cache projection failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
