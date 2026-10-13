import { decodeOutboxEnvelope, encodeOutboxEnvelope, stableStringify } from "@tvic/dal-codec";
import {
  BackendUnavailableError,
  DurableError,
  InvalidArgumentError,
  type DurableOutboxEvent,
  type SessionId,
  type StoredSessionRecord,
  type StoredToolCallRecord,
  type StoredTurnRecord,
} from "@tvic/core";
import type { RedisClient, RedisStoreOptions } from "./index.js";
import {
  cacheEventIndexKey,
  cacheEventKey,
  cacheEventScore,
  sessionIndexKey,
  sessionKey,
  toolIndexKey,
  turnIndexKey,
} from "./keys.js";
import { SORTED_SET_TYPE_GUARD } from "./redis-script-helpers.js";

const RETENTION_SCAN_COUNT = 128;
const RESTORE_CHILD_BATCH_SIZE = 32;

const BEGIN_SESSION_CACHE_PURGE_SCRIPT = `${SORTED_SET_TYPE_GUARD}
local targetIncarnation = tonumber(ARGV[1])
local targetVersion = tonumber(ARGV[2])
local targetFence = tonumber(ARGV[3])
local purgeToken = ARGV[4]
if not targetIncarnation or not targetVersion or not targetFence or
   targetIncarnation < 0 or targetVersion < 0 or targetFence < 0 or
   targetIncarnation % 1 ~= 0 or targetVersion % 1 ~= 0 or targetFence % 1 ~= 0 or
   targetIncarnation > 9007199254740991 or targetVersion > 9007199254740991 or
   targetFence > 9007199254740991 or not purgeToken or #purgeToken == 0 then
  return redis.error_reply('TVIC_CACHE_RETENTION_IDENTITY')
end
local function readIncarnation(metadata)
  if metadata.sessionIncarnation == nil then return 0 end
  local incarnation = tonumber(metadata.sessionIncarnation)
  if not incarnation or incarnation < 0 or incarnation > 9007199254740991 or
     incarnation % 1 ~= 0 then
    return nil
  end
  return incarnation
end
local currentRaw = redis.call('GET', KEYS[2])
if currentRaw then
  local ok, current = pcall(cjson.decode, currentRaw)
  if not ok or type(current) ~= 'table' then
    return redis.error_reply('TVIC_CACHE_METADATA_INVALID')
  end
  local currentIncarnation = readIncarnation(current)
  if currentIncarnation == nil then
    return redis.error_reply('TVIC_CACHE_METADATA_INVALID')
  end
  if currentIncarnation > targetIncarnation then
    return 0
  end
end
for index = 3, 5 do
  if not isSortedSetOrMissing(KEYS[index]) then
    return redis.error_reply('TVIC_CACHE_INDEX_TYPE')
  end
end
redis.call('ZREM', KEYS[3], KEYS[1])
redis.call('DEL', KEYS[1])
redis.call('SET', KEYS[2], cjson.encode({
  sessionIncarnation = targetIncarnation,
  version = targetVersion,
  fence = targetFence,
  retired = true,
  purgeToken = purgeToken,
  purgeComplete = false
}))
return 1
`;

const RESUME_SESSION_CACHE_PURGE_SCRIPT = `${SORTED_SET_TYPE_GUARD}
local targetIncarnation = tonumber(ARGV[1])
local purgeToken = ARGV[2]
if not targetIncarnation or targetIncarnation < 0 or
   targetIncarnation > 9007199254740991 or targetIncarnation % 1 ~= 0 or
   not purgeToken or #purgeToken == 0 then
  return redis.error_reply('TVIC_CACHE_RETENTION_IDENTITY')
end
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local ok, metadata = pcall(cjson.decode, raw)
if not ok or type(metadata) ~= 'table' then
  return redis.error_reply('TVIC_CACHE_METADATA_INVALID')
end
local incarnation = tonumber(metadata.sessionIncarnation)
if not incarnation or incarnation < 0 or incarnation > 9007199254740991 or
   incarnation % 1 ~= 0 then
  return redis.error_reply('TVIC_CACHE_METADATA_INVALID')
end
if incarnation ~= targetIncarnation or metadata.retired ~= true or
   metadata.purgeToken ~= purgeToken then return 0 end
return 1
`;

const COMPLETE_SESSION_CACHE_PURGE_SCRIPT = `${SORTED_SET_TYPE_GUARD}
local targetIncarnation = tonumber(ARGV[1])
local purgeToken = ARGV[2]
if not targetIncarnation or targetIncarnation < 0 or
   targetIncarnation > 9007199254740991 or targetIncarnation % 1 ~= 0 or
   not purgeToken or #purgeToken == 0 then
  return redis.error_reply('TVIC_CACHE_RETENTION_IDENTITY')
end
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local ok, metadata = pcall(cjson.decode, raw)
if not ok or type(metadata) ~= 'table' then
  return redis.error_reply('TVIC_CACHE_METADATA_INVALID')
end
local incarnation = tonumber(metadata.sessionIncarnation)
if not incarnation or incarnation < 0 or incarnation > 9007199254740991 or
   incarnation % 1 ~= 0 then
  return redis.error_reply('TVIC_CACHE_METADATA_INVALID')
end
if incarnation ~= targetIncarnation or metadata.retired ~= true or
   metadata.purgeToken ~= purgeToken then return 0 end
metadata.purgeComplete = true
redis.call('SET', KEYS[1], cjson.encode(metadata))
return 1
`;

const PURGE_SESSION_CHILDREN_BATCH_SCRIPT = `${SORTED_SET_TYPE_GUARD}
local targetIncarnation = tonumber(ARGV[1])
local cursor = ARGV[2]
local count = tonumber(ARGV[3])
if not targetIncarnation or targetIncarnation < 0 or
   targetIncarnation > 9007199254740991 or targetIncarnation % 1 ~= 0 or
   not cursor or not count or count < 1 or count % 1 ~= 0 then
  return redis.error_reply('TVIC_CACHE_RETENTION_IDENTITY')
end
if not isSortedSetOrMissing(KEYS[1]) then
  return redis.error_reply('TVIC_CACHE_INDEX_TYPE')
end
if redis.call('TYPE', KEYS[1]).ok == 'none' then return { '0', 0 } end
local result = redis.call('ZSCAN', KEYS[1], cursor, 'COUNT', count)
local members = result[2]
local parsed = {}
for index = 1, #members, 2 do
  local member = members[index]
  local raw = redis.call('GET', member .. ':cache_meta')
  local incarnation = 0
  if raw then
    local ok, metadata = pcall(cjson.decode, raw)
    if not ok or type(metadata) ~= 'table' then
      return redis.error_reply('TVIC_CACHE_METADATA_INVALID')
    end
    if metadata.sessionIncarnation ~= nil then
      incarnation = tonumber(metadata.sessionIncarnation)
      if not incarnation or incarnation < 0 or incarnation > 9007199254740991 or
         incarnation % 1 ~= 0 then
        return redis.error_reply('TVIC_CACHE_METADATA_INVALID')
      end
    end
  end
  parsed[#parsed + 1] = { member, incarnation }
end
local deleted = 0
for _, child in ipairs(parsed) do
  if child[2] <= targetIncarnation then
    redis.call('DEL', child[1], child[1] .. ':cache_meta')
    redis.call('ZREM', KEYS[1], child[1])
    deleted = deleted + 1
  end
end
if redis.call('ZCARD', KEYS[1]) == 0 then redis.call('DEL', KEYS[1]) end
return { result[1], deleted }
`;

const RESTORE_CACHE_CHILD_SCRIPT = `${SORTED_SET_TYPE_GUARD}
local function readInteger(value)
  local number = tonumber(value)
  if not number or number < 0 or number > 9007199254740991 or number % 1 ~= 0 then
    return nil
  end
  return number
end
local incarnation = readInteger(ARGV[2])
local version = readInteger(ARGV[3])
local fence = readInteger(ARGV[4])
local score = tonumber(ARGV[5])
local purgeToken = ARGV[6]
if incarnation == nil or version == nil or fence == nil or not score or
   score ~= score or score == math.huge or score == -math.huge or
   not purgeToken or #purgeToken == 0 then
  return redis.error_reply('TVIC_CACHE_RETENTION_IDENTITY')
end
local parentRaw = redis.call('GET', KEYS[4])
if not parentRaw then return 0 end
local parentOk, parent = pcall(cjson.decode, parentRaw)
if not parentOk or type(parent) ~= 'table' then
  return redis.error_reply('TVIC_CACHE_METADATA_INVALID')
end
local parentIncarnation = readInteger(parent.sessionIncarnation)
if parentIncarnation == nil then
  return redis.error_reply('TVIC_CACHE_METADATA_INVALID')
end
if parentIncarnation ~= incarnation or parent.retired ~= true or parent.purgeComplete ~= true or
   parent.purgeToken ~= purgeToken then return 0 end
local currentRaw = redis.call('GET', KEYS[3])
if currentRaw then
  local currentOk, current = pcall(cjson.decode, currentRaw)
  if not currentOk or type(current) ~= 'table' then
    return redis.error_reply('TVIC_CACHE_METADATA_INVALID')
  end
  local currentIncarnation = current.sessionIncarnation == nil and 0 or
    readInteger(current.sessionIncarnation)
  local currentVersion = readInteger(current.version)
  local currentFence = readInteger(current.fence)
  if currentIncarnation == nil or currentVersion == nil or currentFence == nil then
    return redis.error_reply('TVIC_CACHE_METADATA_INVALID')
  end
  if currentIncarnation > incarnation or
     (currentIncarnation == incarnation and
       (currentVersion > version or (currentVersion == version and currentFence >= fence))) then
    return 0
  end
end
if not isSortedSetOrMissing(KEYS[2]) then
  return redis.error_reply('TVIC_RECORD_INDEX_TYPE')
end
redis.call('ZADD', KEYS[2], ARGV[5], KEYS[1])
redis.call('MSET', KEYS[1], ARGV[1], KEYS[3], cjson.encode({
  sessionIncarnation = incarnation,
  version = version,
  fence = fence
}))
return 1
`;

const RESTORE_SESSION_CACHE_SCRIPT = `${SORTED_SET_TYPE_GUARD}
local function readInteger(value)
  local number = tonumber(value)
  if not number or number < 0 or number > 9007199254740991 or number % 1 ~= 0 then
    return nil
  end
  return number
end
local incarnation = readInteger(ARGV[2])
local version = readInteger(ARGV[3])
local fence = readInteger(ARGV[4])
local score = tonumber(ARGV[5])
local purgeToken = ARGV[6]
if incarnation == nil or version == nil or fence == nil or not score or
   score ~= score or score == math.huge or score == -math.huge or
   not purgeToken or #purgeToken == 0 then
  return redis.error_reply('TVIC_CACHE_RETENTION_IDENTITY')
end
local raw = redis.call('GET', KEYS[3])
if not raw then return 0 end
local ok, metadata = pcall(cjson.decode, raw)
if not ok or type(metadata) ~= 'table' then
  return redis.error_reply('TVIC_CACHE_METADATA_INVALID')
end
local currentIncarnation = readInteger(metadata.sessionIncarnation)
if currentIncarnation == nil then
  return redis.error_reply('TVIC_CACHE_METADATA_INVALID')
end
if currentIncarnation ~= incarnation or metadata.retired ~= true or metadata.purgeComplete ~= true or
   metadata.purgeToken ~= purgeToken then return 0 end
if not isSortedSetOrMissing(KEYS[2]) then
  return redis.error_reply('TVIC_RECORD_INDEX_TYPE')
end
redis.call('ZADD', KEYS[2], ARGV[5], KEYS[1])
metadata.version = version
metadata.fence = fence
metadata.retired = false
metadata.purgeToken = nil
redis.call('MSET', KEYS[1], ARGV[1], KEYS[3], cjson.encode(metadata))
return 1
`;

export interface ProjectedSessionRetentionIdentity {
  readonly sessionId: SessionId;
  readonly incarnation: number | string;
  readonly version: number | string;
  readonly fence: number | string;
}

export interface ProjectedSessionCacheSnapshot {
  readonly session: StoredSessionRecord;
  readonly turns: Iterable<StoredTurnRecord> | AsyncIterable<StoredTurnRecord>;
  readonly toolCalls: Iterable<StoredToolCallRecord> | AsyncIterable<StoredToolCallRecord>;
}

export class SessionCacheRetentionPendingError extends BackendUnavailableError {
  constructor() {
    super("Redis cache projection is waiting for retention recovery");
    this.name = "SessionCacheRetentionPendingError";
  }
}

const APPLY_CACHE_EVENT_SCRIPT = `${SORTED_SET_TYPE_GUARD}
local function readInteger(value)
  local number = tonumber(value)
  if not number or number < 0 or number > 9007199254740991 or number % 1 ~= 0 then
    return nil
  end
  return number
end
local incomingIncarnation = readInteger(ARGV[2])
local incomingVersion = readInteger(ARGV[3])
local incomingFence = readInteger(ARGV[4])
if incomingIncarnation == nil or incomingVersion == nil or incomingFence == nil then
  return redis.error_reply('TVIC_CACHE_METADATA_INVALID')
end
local parentRaw = redis.call('GET', KEYS[4])
if parentRaw then
  local ok, parent = pcall(cjson.decode, parentRaw)
  if not ok or type(parent) ~= 'table' then
    return redis.error_reply('TVIC_CACHE_METADATA_INVALID')
  end
  local parentIncarnation = 0
  if parent.sessionIncarnation ~= nil then
    parentIncarnation = readInteger(parent.sessionIncarnation)
    if parentIncarnation == nil then
      return redis.error_reply('TVIC_CACHE_METADATA_INVALID')
    end
  end
  if parent.retired ~= nil and type(parent.retired) ~= 'boolean' then
    return redis.error_reply('TVIC_CACHE_METADATA_INVALID')
  end
  if parentIncarnation > incomingIncarnation then
    return 0
  end
  if parent.retired == true and parentIncarnation == incomingIncarnation then
    -- Recovery is rebuilding this incarnation. Keep the outbox row retryable
    -- until the tombstone is reopened so its event cannot be lost.
    return -1
  end
end
local currentRaw = redis.call('GET', KEYS[3])
if currentRaw then
  local ok, current = pcall(cjson.decode, currentRaw)
  if not ok or type(current) ~= 'table' then
    return redis.error_reply('TVIC_CACHE_METADATA_INVALID')
  end
  local currentIncarnation = 0
  if current.sessionIncarnation ~= nil then
    currentIncarnation = readInteger(current.sessionIncarnation)
    if currentIncarnation == nil then
      return redis.error_reply('TVIC_CACHE_METADATA_INVALID')
    end
  end
  local currentFence = readInteger(current.fence)
  local currentVersion = readInteger(current.version)
  if currentFence == nil or currentVersion == nil then
    return redis.error_reply('TVIC_CACHE_METADATA_INVALID')
  end
  if currentIncarnation > incomingIncarnation or
     (currentIncarnation == incomingIncarnation and
       (currentVersion > incomingVersion or
         (currentVersion == incomingVersion and currentFence >= incomingFence))) then
    return 0
  end
end
local score = tonumber(ARGV[5])
if not score or score ~= score or score == math.huge or score == -math.huge then
  return redis.error_reply('TVIC_RECORD_INDEX_SCORE')
end
if not isSortedSetOrMissing(KEYS[2]) then
  return redis.error_reply('TVIC_RECORD_INDEX_TYPE')
end
redis.call('ZADD', KEYS[2], ARGV[5], KEYS[1])
redis.call('MSET', KEYS[1], ARGV[1], KEYS[3], cjson.encode({
  sessionIncarnation = incomingIncarnation,
  version = incomingVersion,
  fence = incomingFence
}))
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
      const sessionIncarnation =
        event.sessionIncarnation === undefined ? 0 : event.sessionIncarnation;
      if (!Number.isSafeInteger(sessionIncarnation) || sessionIncarnation < 0) {
        throw new InvalidArgumentError(
          "Outbox session incarnation must be a safe non-negative integer",
        );
      }
      const score = cacheEventScore(event.aggregateType, envelope.payload);
      const encoded = stableStringify(envelope);
      const result = await this.client.eval(
        APPLY_CACHE_EVENT_SCRIPT,
        [
          key,
          indexKey,
          `${key}:cache_meta`,
          `${sessionKey(this.options.prefix, event.sessionId)}:cache_meta`,
        ],
        [
          encoded,
          String(sessionIncarnation),
          String(event.version),
          String(event.fence),
          String(score),
        ],
      );
      if (Number(result) === -1) {
        throw new SessionCacheRetentionPendingError();
      }
    } catch (error) {
      if (error instanceof DurableError) throw error;
      throw new BackendUnavailableError(
        `Redis cache projection failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Remove a retained PostgreSQL session's Redis projections without deleting a newer lifetime. */
  async purgeSession(
    identity: ProjectedSessionRetentionIdentity,
    purgeToken: string,
  ): Promise<void> {
    const numericIdentity = [identity.incarnation, identity.version, identity.fence].map(
      readNonNegativeSafeInteger,
    );
    if (numericIdentity.some((value) => value === null)) {
      throw new InvalidArgumentError("Projected session retention identity is invalid");
    }
    const [incarnation, version, fence] = numericIdentity as [number, number, number];
    if (typeof purgeToken !== "string" || purgeToken.length === 0) {
      throw new InvalidArgumentError("Projected session purge token must be non-empty");
    }
    const session = sessionKey(this.options.prefix, identity.sessionId);
    try {
      const initialized = await this.client.eval(
        BEGIN_SESSION_CACHE_PURGE_SCRIPT,
        [
          session,
          `${session}:cache_meta`,
          sessionIndexKey(this.options.prefix),
          turnIndexKey(this.options.prefix, identity.sessionId),
          toolIndexKey(this.options.prefix, identity.sessionId),
        ],
        [String(incarnation), String(version), String(fence), purgeToken],
      );
      if (Number(initialized) !== 1) return;
      await this.#purgeChildren(turnIndexKey(this.options.prefix, identity.sessionId), incarnation);
      await this.#purgeChildren(toolIndexKey(this.options.prefix, identity.sessionId), incarnation);
      await this.#completePurge(identity.sessionId, incarnation, purgeToken);
    } catch (error) {
      if (error instanceof DurableError) throw error;
      throw new BackendUnavailableError(
        `Redis cache retention failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Finishes an interrupted Redis purge only while its original token still owns the tombstone. */
  async resumeSessionPurge(
    identity: ProjectedSessionRetentionIdentity,
    purgeToken: string,
  ): Promise<boolean> {
    const numericIdentity = [identity.incarnation, identity.version, identity.fence].map(
      readNonNegativeSafeInteger,
    );
    if (
      numericIdentity.some((value) => value === null) ||
      typeof purgeToken !== "string" ||
      purgeToken.length === 0
    ) {
      throw new InvalidArgumentError("Projected session retention identity is invalid");
    }
    const [incarnation] = numericIdentity as [number, number, number];
    const session = sessionKey(this.options.prefix, identity.sessionId);
    try {
      const owned = await this.client.eval(
        RESUME_SESSION_CACHE_PURGE_SCRIPT,
        [`${session}:cache_meta`],
        [String(incarnation), purgeToken],
      );
      if (Number(owned) !== 1) return false;
      await this.#purgeChildren(turnIndexKey(this.options.prefix, identity.sessionId), incarnation);
      await this.#purgeChildren(toolIndexKey(this.options.prefix, identity.sessionId), incarnation);
      return this.#completePurge(identity.sessionId, incarnation, purgeToken);
    } catch (error) {
      if (error instanceof DurableError) throw error;
      throw new BackendUnavailableError(
        `Redis cache retention recovery failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Returns the current retired-session token so a retry worker can resume recovery. */
  async getSessionPurgeToken(
    identity: Pick<ProjectedSessionRetentionIdentity, "sessionId" | "incarnation">,
  ): Promise<string | null> {
    const incarnation = readNonNegativeSafeInteger(identity.incarnation);
    if (incarnation === null) {
      throw new InvalidArgumentError("Projected session incarnation is invalid");
    }
    try {
      const raw = await this.client.get(
        `${sessionKey(this.options.prefix, identity.sessionId)}:cache_meta`,
      );
      if (raw === null) return null;
      const metadata: unknown = JSON.parse(raw);
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
        throw new BackendUnavailableError("Redis cache retention metadata is invalid");
      }
      const value = metadata as Record<string, unknown>;
      const actualIncarnation = readNonNegativeSafeInteger(value.sessionIncarnation);
      if (actualIncarnation === null || typeof value.retired !== "boolean") {
        throw new BackendUnavailableError("Redis cache retention metadata is invalid");
      }
      if (actualIncarnation !== incarnation || value.retired !== true) return null;
      if (value.purgeComplete !== undefined && typeof value.purgeComplete !== "boolean") {
        throw new BackendUnavailableError("Redis cache retention metadata is invalid");
      }
      if (typeof value.purgeToken !== "string" || value.purgeToken.length === 0) {
        throw new BackendUnavailableError("Redis cache retention metadata has no purge token");
      }
      return value.purgeToken;
    } catch (error) {
      if (error instanceof DurableError) throw error;
      throw new BackendUnavailableError(
        `Redis cache retention lookup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Restores the current PostgreSQL snapshot after its retention delete rolls back. */
  async restoreSessionProjection(
    identity: ProjectedSessionRetentionIdentity,
    purgeToken: string,
    snapshot: ProjectedSessionCacheSnapshot,
  ): Promise<void> {
    const numericIdentity = [identity.incarnation, identity.version, identity.fence].map(
      readNonNegativeSafeInteger,
    );
    if (
      numericIdentity.some((value) => value === null) ||
      typeof purgeToken !== "string" ||
      purgeToken.length === 0
    ) {
      throw new InvalidArgumentError("Projected session retention identity is invalid");
    }
    const [incarnation, , fence] = numericIdentity as [number, number, number];
    const session = snapshot.session.session;
    if (session.id !== identity.sessionId) {
      throw new InvalidArgumentError("Projected session snapshot has a different session ID");
    }
    const sessionVersion = persistedVersion(snapshot.session.version);
    const sessionEvent: DurableOutboxEvent = {
      id: `restore:${purgeToken}:session:${session.id}`,
      aggregateType: "session",
      aggregateId: session.id,
      sessionId: session.id,
      sessionIncarnation: incarnation,
      version: sessionVersion,
      fence,
      envelope: encodeOutboxEnvelope(
        {
          kind: "session",
          payload: session,
          runtime: snapshot.session.runtime,
          version: sessionVersion,
        },
        `cache-restore:session:${session.id}`,
      ),
    };
    try {
      await restoreInBatches(snapshot.turns, RESTORE_CHILD_BATCH_SIZE, (record) => {
        const version = persistedVersion(record.version);
        const event: DurableOutboxEvent = {
          id: `restore:${purgeToken}:turn:${record.turn.id}`,
          aggregateType: "turn",
          aggregateId: record.turn.id,
          sessionId: identity.sessionId,
          sessionIncarnation: incarnation,
          version,
          fence,
          envelope: encodeOutboxEnvelope(
            { kind: "turn", payload: record.turn, runtime: record.runtime, version },
            `cache-restore:turn:${record.turn.sessionId}:${record.turn.id}`,
          ),
        };
        return this.#restoreCacheChild(event, purgeToken, incarnation);
      });
      await restoreInBatches(snapshot.toolCalls, RESTORE_CHILD_BATCH_SIZE, (record) => {
        const version = persistedVersion(record.version);
        const event: DurableOutboxEvent = {
          id: `restore:${purgeToken}:tool_call:${record.toolCall.toolCallId}`,
          aggregateType: "tool_call",
          aggregateId: record.toolCall.toolCallId,
          sessionId: identity.sessionId,
          sessionIncarnation: incarnation,
          version,
          fence,
          envelope: encodeOutboxEnvelope(
            { kind: "tool_call", payload: record.toolCall, runtime: record.runtime, version },
            `cache-restore:tool_call:${record.toolCall.sessionId}:${record.toolCall.toolCallId}`,
          ),
        };
        return this.#restoreCacheChild(event, purgeToken, incarnation);
      });
      const sessionKeyValue = sessionKey(this.options.prefix, identity.sessionId);
      await this.client.eval(
        RESTORE_SESSION_CACHE_SCRIPT,
        [sessionKeyValue, sessionIndexKey(this.options.prefix), `${sessionKeyValue}:cache_meta`],
        [
          stableStringify(sessionEvent.envelope),
          String(incarnation),
          String(sessionVersion),
          String(fence),
          String(cacheEventScore("session", session)),
          purgeToken,
        ],
      );
    } catch (error) {
      if (error instanceof DurableError) throw error;
      throw new BackendUnavailableError(
        `Redis cache retention recovery failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async #restoreCacheChild(
    event: DurableOutboxEvent,
    purgeToken: string,
    incarnation: number,
  ): Promise<void> {
    const key = cacheEventKey(this.options.prefix, event);
    const indexKey = cacheEventIndexKey(this.options.prefix, event);
    const parentKey = sessionKey(this.options.prefix, event.sessionId);
    await this.client.eval(
      RESTORE_CACHE_CHILD_SCRIPT,
      [key, indexKey, `${key}:cache_meta`, `${parentKey}:cache_meta`],
      [
        stableStringify(event.envelope),
        String(incarnation),
        String(event.version),
        String(event.fence),
        String(cacheEventScore(event.aggregateType, event.envelope.payload)),
        purgeToken,
      ],
    );
  }

  async #completePurge(
    sessionId: SessionId,
    incarnation: number,
    purgeToken: string,
  ): Promise<boolean> {
    const session = sessionKey(this.options.prefix, sessionId);
    const result = await this.client.eval(
      COMPLETE_SESSION_CACHE_PURGE_SCRIPT,
      [`${session}:cache_meta`],
      [String(incarnation), purgeToken],
    );
    return Number(result) === 1;
  }

  async #purgeChildren(indexKey: string, incarnation: number): Promise<void> {
    let cursor = "0";
    let deletedThisPass = 0;
    while (true) {
      const result = await this.client.eval(
        PURGE_SESSION_CHILDREN_BATCH_SCRIPT,
        [indexKey],
        [String(incarnation), cursor, String(RETENTION_SCAN_COUNT)],
      );
      if (!Array.isArray(result) || result.length < 2) {
        throw new BackendUnavailableError("Redis returned an invalid cache retention batch");
      }
      cursor = String(result[0]);
      deletedThisPass += Number(result[1]);
      if (cursor === "0") {
        if (deletedThisPass === 0) return;
        deletedThisPass = 0;
      }
    }
  }
}

function readNonNegativeSafeInteger(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && value.trim().length === 0) return null;
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : null;
}

function persistedVersion(value: number | undefined): number {
  const version = value ?? 1;
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new InvalidArgumentError("Projected aggregate version is invalid");
  }
  return version;
}

async function restoreInBatches<T>(
  values: Iterable<T> | AsyncIterable<T>,
  batchSize: number,
  restore: (value: T) => Promise<void>,
): Promise<void> {
  let batch: T[] = [];
  for await (const value of values) {
    batch.push(value);
    if (batch.length === batchSize) {
      await Promise.all(batch.map(restore));
      batch = [];
    }
  }
  if (batch.length > 0) await Promise.all(batch.map(restore));
}
