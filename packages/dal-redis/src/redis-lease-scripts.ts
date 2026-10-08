import { decodeKeyPart, encodeKeyPart } from "./keys.js";

const SORTED_SET_TYPE_GUARD = `
local function isSortedSetOrMissing(key)
  local keyType = redis.call('TYPE', key).ok
  return keyType == 'none' or keyType == 'zset'
end
`;

export const ACQUIRE_LEASE_SCRIPT = `${SORTED_SET_TYPE_GUARD}
local raw = redis.call('GET', KEYS[1])
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
if raw then
  local current = cjson.decode(raw)
  if tonumber(current.expiresAtMs) > now then
    if current.holder == ARGV[1] then
      if not isSortedSetOrMissing(KEYS[2]) or not isSortedSetOrMissing(KEYS[3]) then
        return redis.error_reply('TVIC_LEASE_INDEX_TYPE')
      end
      redis.call('ZADD', KEYS[2], current.expiresAtMs, ARGV[4])
      redis.call('ZREM', KEYS[3], ARGV[2])
      return raw
    else
      return ''
    end
  end
  if not isSortedSetOrMissing(KEYS[2]) or not isSortedSetOrMissing(KEYS[3]) then
    return redis.error_reply('TVIC_LEASE_INDEX_TYPE')
  end
  local next = {sessionId = ARGV[2], holder = ARGV[1], fence = tonumber(current.fence) + 1, generationId = ARGV[5], acquiredAtMs = now, renewedAtMs = now, expiresAtMs = now + tonumber(ARGV[3])}
  local encoded = cjson.encode(next)
  redis.call('SET', KEYS[1], encoded)
  redis.call('ZADD', KEYS[2], next.expiresAtMs, ARGV[4])
  redis.call('ZREM', KEYS[3], ARGV[2])
  return encoded
end
if not isSortedSetOrMissing(KEYS[2]) or not isSortedSetOrMissing(KEYS[3]) then
  return redis.error_reply('TVIC_LEASE_INDEX_TYPE')
end
local next = {sessionId = ARGV[2], holder = ARGV[1], fence = 1, generationId = ARGV[5], acquiredAtMs = now, renewedAtMs = now, expiresAtMs = now + tonumber(ARGV[3])}
local encoded = cjson.encode(next)
redis.call('SET', KEYS[1], encoded)
redis.call('ZADD', KEYS[2], next.expiresAtMs, ARGV[4])
redis.call('ZREM', KEYS[3], ARGV[2])
return encoded
`;

export const RENEW_LEASE_SCRIPT = `
${SORTED_SET_TYPE_GUARD}
local raw = redis.call('GET', KEYS[1])
if not raw then return '' end
local current = cjson.decode(raw)
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local generationId = current.generationId
if generationId == nil then
  generationId = 'legacy:' .. tostring(tonumber(current.fence)) .. ':' .. tostring(tonumber(current.acquiredAtMs))
end
if current.holder ~= ARGV[1] or tonumber(current.fence) ~= tonumber(ARGV[2]) or generationId ~= ARGV[5] or tonumber(current.expiresAtMs) <= now then return '' end
if not isSortedSetOrMissing(KEYS[2]) or not isSortedSetOrMissing(KEYS[3]) then
  return redis.error_reply('TVIC_LEASE_INDEX_TYPE')
end
current.renewedAtMs = now
current.expiresAtMs = now + tonumber(ARGV[3])
local encoded = cjson.encode(current)
redis.call('SET', KEYS[1], encoded)
redis.call('ZADD', KEYS[2], current.expiresAtMs, ARGV[4])
redis.call('ZREM', KEYS[3], current.sessionId)
return encoded
`;

export const RELEASE_LEASE_SCRIPT = `${SORTED_SET_TYPE_GUARD}
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local current = cjson.decode(raw)
local generationId = current.generationId
if generationId == nil then
  generationId = 'legacy:' .. tostring(tonumber(current.fence)) .. ':' .. tostring(tonumber(current.acquiredAtMs))
end
if current.holder ~= ARGV[1] or tonumber(current.fence) ~= tonumber(ARGV[2]) or generationId ~= ARGV[5] then return 0 end
if not isSortedSetOrMissing(KEYS[2]) or not isSortedSetOrMissing(KEYS[3]) then
  return redis.error_reply('TVIC_LEASE_INDEX_TYPE')
end
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
redis.call('ZREM', KEYS[3], ARGV[4])
local generationId = current.generationId
if generationId == nil then
  generationId = 'legacy:' .. tostring(tonumber(current.fence)) .. ':' .. tostring(tonumber(current.acquiredAtMs))
end
if current.recoveryResolvedGenerationId ~= generationId and tonumber(current.recoveryResolvedFence) ~= tonumber(current.fence) then
  redis.call('ZADD', KEYS[2], now, ARGV[3])
else
  redis.call('ZREM', KEYS[2], ARGV[3])
end
current.renewedAtMs = now
current.expiresAtMs = now
redis.call('SET', KEYS[1], cjson.encode(current))
return 1
`;

export const ACK_RECOVERY_CANDIDATE_SCRIPT = `${SORTED_SET_TYPE_GUARD}
local raw = redis.pcall('GET', KEYS[1])
if not raw or type(raw) == 'table' then return 0 end
local ok, current = pcall(cjson.decode, raw)
if not ok or type(current) ~= 'table' then return 0 end
local fence = tonumber(current.fence)
local expiresAtMs = tonumber(current.expiresAtMs)
local acquiredAtMs = tonumber(current.acquiredAtMs)
if not fence or not expiresAtMs or not acquiredAtMs or current.sessionId ~= ARGV[1] or fence ~= tonumber(ARGV[2]) then
  return 0
end
local generationId = current.generationId
if generationId == nil then
  generationId = 'legacy:' .. tostring(fence) .. ':' .. tostring(acquiredAtMs)
elseif type(generationId) ~= 'string' then
  return 0
end
if generationId ~= ARGV[3] then return 0 end
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
if expiresAtMs > now then return 0 end
if not isSortedSetOrMissing(KEYS[2]) or not isSortedSetOrMissing(KEYS[3]) then
  return redis.error_reply('TVIC_LEASE_INDEX_TYPE')
end
current.recoveryResolvedGenerationId = generationId
redis.call('SET', KEYS[1], cjson.encode(current))
redis.call('ZREM', KEYS[2], ARGV[4])
redis.call('ZREM', KEYS[3], ARGV[1])
return 1
`;

export const LIST_RECOVERY_CANDIDATES_SCRIPT = `${SORTED_SET_TYPE_GUARD}
-- TVIC_BOUNDED_RECOVERY_PAGE
-- The expiry index is authoritative; this stable queue retains expired IDs for retryable pages.
local function encodeKeyPart(value)
  local output = {}
  for index = 1, #value do
    local byte = string.byte(value, index)
    local safe = (byte >= 48 and byte <= 57) or
      (byte >= 65 and byte <= 90) or
      (byte >= 97 and byte <= 122) or
      byte == 45 or byte == 95 or byte == 46 or byte == 33 or
      byte == 126 or byte == 42 or byte == 39 or byte == 40 or byte == 41
    if safe then
      output[#output + 1] = string.char(byte)
    else
      output[#output + 1] = string.format('%%%02X', byte)
    end
  end
  return table.concat(output)
end
local function readLease(raw)
  local ok, lease = pcall(cjson.decode, raw)
  if not ok or type(lease) ~= 'table' or type(lease.sessionId) ~= 'string' then
    return nil, nil
  end
  local expires = lease.expiresAtMs
  if type(expires) ~= 'number' and type(expires) ~= 'string' then
    return nil, nil
  end
  if type(lease.fence) ~= 'number' and type(lease.fence) ~= 'string' then
    return nil, nil
  end
  if type(lease.acquiredAtMs) ~= 'number' and type(lease.acquiredAtMs) ~= 'string' then
    return nil, nil
  end
  expires = tonumber(expires)
  if not expires or not tonumber(lease.fence) or not tonumber(lease.acquiredAtMs) then
    return nil, nil
  end
  return lease, expires
end
local function leaseGenerationId(lease)
  if type(lease.generationId) == 'string' and #lease.generationId > 0 then
    return lease.generationId
  end
  if lease.generationId ~= nil then return nil end
  return 'legacy:' .. tostring(tonumber(lease.fence)) .. ':' .. tostring(tonumber(lease.acquiredAtMs))
end
local function recoveryResolved(lease, generationId)
  return lease.recoveryResolvedGenerationId == generationId or
    tonumber(lease.recoveryResolvedFence) == tonumber(lease.fence)
end
if not isSortedSetOrMissing(KEYS[1]) or not isSortedSetOrMissing(KEYS[2]) then
  return redis.error_reply('TVIC_LEASE_INDEX_TYPE')
end
local min = '-'
if ARGV[1] == '1' then min = '(' .. ARGV[2] end
local limit = tonumber(ARGV[3])
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now, 'LIMIT', 0, limit + 1)
local dueCount = math.min(#due, limit)
for index = 1, dueCount do
  local encodedId = due[index]
  local raw = redis.pcall('GET', ARGV[4] .. encodedId)
  if type(raw) == 'table' then raw = nil end
  if raw then
    local lease, expiresAtMs = readLease(raw)
    local generationId = lease and leaseGenerationId(lease)
    if lease and generationId and encodeKeyPart(lease.sessionId) == encodedId then
      if recoveryResolved(lease, generationId) then
        redis.call('ZREM', KEYS[1], encodedId)
        redis.call('ZREM', KEYS[2], lease.sessionId)
      elseif expiresAtMs <= now then
        redis.call('ZADD', KEYS[2], 0, lease.sessionId)
        redis.call('ZREM', KEYS[1], encodedId)
      else
        -- The member already exists in this ZSET; update its score in place.
        redis.call('ZADD', KEYS[1], expiresAtMs, encodedId)
      end
    else
      redis.call('ZREM', KEYS[1], encodedId)
    end
  else
    redis.call('ZREM', KEYS[1], encodedId)
  end
end
local members = redis.call('ZRANGEBYLEX', KEYS[2], min, '+', 'LIMIT', 0, limit + 1)
local candidates = {}
local candidateFences = {}
local candidateGenerationIds = {}
local inspected = math.min(#members, limit)
for index = 1, inspected do
  local sessionId = members[index]
  local raw = redis.pcall('GET', ARGV[4] .. encodeKeyPart(sessionId))
  if type(raw) == 'table' then raw = nil end
  if raw then
    local lease, expiresAtMs = readLease(raw)
    local generationId = lease and leaseGenerationId(lease)
    if lease and generationId and lease.sessionId == sessionId and expiresAtMs <= now then
      if recoveryResolved(lease, generationId) then
        redis.call('ZREM', KEYS[2], sessionId)
      else
        candidates[#candidates + 1] = sessionId
        candidateFences[#candidateFences + 1] = tonumber(lease.fence)
        candidateGenerationIds[#candidateGenerationIds + 1] = generationId
      end
    else
      if lease and lease.sessionId == sessionId then
        redis.call('ZADD', KEYS[1], expiresAtMs, encodeKeyPart(sessionId))
      end
      redis.call('ZREM', KEYS[2], sessionId)
    end
  else
    redis.call('ZREM', KEYS[2], sessionId)
  end
end
local lastExamined = ''
if inspected > 0 then lastExamined = members[inspected] end
return {candidates, candidateFences, candidateGenerationIds, lastExamined, #members > limit and 1 or 0, inspected, #due > limit and 1 or 0}
`;

const RECOVERY_CURSOR_PREFIX = "__tvic_recovery_cursor_v1__:";
export const INITIAL_RECOVERY_CURSOR = `${RECOVERY_CURSOR_PREFIX}start`;

export function encodeRecoveryCursor(sessionId: string): string {
  return `${RECOVERY_CURSOR_PREFIX}id:${encodeKeyPart(sessionId)}`;
}

export function decodeRecoveryCursor(cursor: string | undefined): {
  readonly provided: boolean;
  readonly sessionId: string;
} {
  if (cursor === undefined) return { provided: false, sessionId: "" };
  if (cursor === INITIAL_RECOVERY_CURSOR) return { provided: false, sessionId: "" };
  if (cursor.startsWith(`${RECOVERY_CURSOR_PREFIX}id:`)) {
    return {
      provided: true,
      sessionId: decodeKeyPart(cursor.slice(`${RECOVERY_CURSOR_PREFIX}id:`.length)),
    };
  }
  // Accept a plain session ID cursor from callers running the previous adapter.
  return { provided: true, sessionId: cursor };
}

export const PREPARE_SESSION_LEASE_SCRIPT = `${SORTED_SET_TYPE_GUARD}
local existingRaw = redis.call('GET', KEYS[1])
if existingRaw and existingRaw ~= ARGV[1] then return -1 end
local leaseRaw = redis.call('GET', KEYS[3])
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local current = leaseRaw and cjson.decode(leaseRaw) or nil
if current and tonumber(current.expiresAtMs) > now then
  if current.holder ~= ARGV[2] then return 0 end
  if not isSortedSetOrMissing(KEYS[4]) or not isSortedSetOrMissing(KEYS[5]) then
    return redis.error_reply('TVIC_LEASE_INDEX_TYPE')
  end
  redis.call('ZADD', KEYS[4], current.expiresAtMs, ARGV[5])
  redis.call('ZREM', KEYS[5], ARGV[3])
  return leaseRaw
end
if not isSortedSetOrMissing(KEYS[4]) or not isSortedSetOrMissing(KEYS[5]) then
  return redis.error_reply('TVIC_LEASE_INDEX_TYPE')
end
local lease = {
  sessionId = ARGV[3],
  holder = ARGV[2],
  fence = current and tonumber(current.fence) + 1 or 1,
  generationId = ARGV[6],
  acquiredAtMs = now,
  renewedAtMs = now,
  expiresAtMs = now + tonumber(ARGV[4])
}
local encoded = cjson.encode(lease)
redis.call('SET', KEYS[3], encoded)
redis.call('ZADD', KEYS[4], lease.expiresAtMs, ARGV[5])
redis.call('ZREM', KEYS[5], ARGV[3])
return encoded
`;

export const FINALIZE_SESSION_CREATION_SCRIPT = `
local leaseRaw = redis.call('GET', KEYS[3])
if not leaseRaw then return 0 end
local lease = cjson.decode(leaseRaw)
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local generationId = lease.generationId
if generationId == nil then
  generationId = 'legacy:' .. tostring(tonumber(lease.fence)) .. ':' .. tostring(tonumber(lease.acquiredAtMs))
end
if lease.holder ~= ARGV[2] or tonumber(lease.fence) ~= tonumber(ARGV[4]) or generationId ~= ARGV[9] or tonumber(lease.expiresAtMs) <= now then return 0 end
local existingRaw = redis.call('GET', KEYS[1])
if existingRaw and existingRaw ~= ARGV[1] then return -1 end
if not existingRaw then
  redis.call('SET', KEYS[1], ARGV[1])
end
-- Repair the derived session index on retries as well as on first creation.
-- A process can crash after SET session but before the index write; finalization
-- is the next safe point at which the exact same session is known to be valid.
-- The index member is the encoded session id, matching every other lease path.
redis.call('ZADD', KEYS[2], ARGV[7], ARGV[8])
if ARGV[5] ~= '' then
  redis.call('SET', ARGV[6], ARGV[5])
end
return 1
`;
