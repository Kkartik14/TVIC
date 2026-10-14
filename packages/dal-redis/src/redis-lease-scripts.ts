import { InvalidArgumentError } from "@tvic/core";
import { decodeKeyPart, encodeKeyPart } from "./keys.js";
import { LEASE_NUMERIC_GUARD, SORTED_SET_TYPE_GUARD } from "./redis-script-helpers.js";

export const ACQUIRE_LEASE_SCRIPT = `${SORTED_SET_TYPE_GUARD}${LEASE_NUMERIC_GUARD}
local raw = redis.call('GET', KEYS[1])
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local ttl = safeInteger(ARGV[3], 1)
local expiresAtMs = safeLeaseExpiry(now, ARGV[3])
if not ttl or not expiresAtMs then return redis.error_reply('TVIC_LEASE_EXPIRY_RANGE') end
if raw then
  local current, currentExpiresAtMs, currentFence = readLease(raw)
  if not current or current.sessionId ~= ARGV[2] then
    return redis.error_reply('TVIC_LEASE_RECORD_INVALID')
  end
  if currentExpiresAtMs > now then
    if current.holder == ARGV[1] then
      if not isSortedSetOrMissing(KEYS[2]) or not isSortedSetOrMissing(KEYS[3]) then
        return redis.error_reply('TVIC_LEASE_INDEX_TYPE')
      end
      redis.call('ZADD', KEYS[2], currentExpiresAtMs, ARGV[4])
      redis.call('ZREM', KEYS[3], ARGV[2])
      return raw
    else
      return ''
    end
  end
  if not isSortedSetOrMissing(KEYS[2]) or not isSortedSetOrMissing(KEYS[3]) then
    return redis.error_reply('TVIC_LEASE_INDEX_TYPE')
  end
  if currentFence >= MAX_SAFE_INTEGER then
    return redis.error_reply('TVIC_LEASE_FENCE_RANGE')
  end
  local next = {sessionId = ARGV[2], holder = ARGV[1], fence = currentFence + 1, generationId = ARGV[5], acquiredAtMs = now, renewedAtMs = now, expiresAtMs = expiresAtMs}
  local encoded = cjson.encode(next)
  redis.call('ZADD', KEYS[2], currentExpiresAtMs, ARGV[4])
  redis.call('SET', KEYS[1], encoded)
  redis.call('ZADD', KEYS[2], next.expiresAtMs, ARGV[4])
  redis.call('ZREM', KEYS[3], ARGV[2])
  return encoded
end
if not isSortedSetOrMissing(KEYS[2]) or not isSortedSetOrMissing(KEYS[3]) then
  return redis.error_reply('TVIC_LEASE_INDEX_TYPE')
end
local next = {sessionId = ARGV[2], holder = ARGV[1], fence = 1, generationId = ARGV[5], acquiredAtMs = now, renewedAtMs = now, expiresAtMs = expiresAtMs}
local encoded = cjson.encode(next)
redis.call('ZADD', KEYS[2], next.expiresAtMs, ARGV[4])
redis.call('SET', KEYS[1], encoded)
redis.call('ZREM', KEYS[3], ARGV[2])
return encoded
`;

export const RENEW_LEASE_SCRIPT = `
${SORTED_SET_TYPE_GUARD}${LEASE_NUMERIC_GUARD}
local raw = redis.call('GET', KEYS[1])
if not raw then return '' end
local current, currentExpiresAtMs, currentFence = readLease(raw)
if not current or current.sessionId ~= ARGV[6] then
  return redis.error_reply('TVIC_LEASE_RECORD_INVALID')
end
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local requestedFence = safeInteger(ARGV[2], 1)
local expiresAtMs = safeLeaseExpiry(now, ARGV[3])
if not safeTimestamp(now) or not requestedFence or not expiresAtMs then
  return redis.error_reply('TVIC_LEASE_EXPIRY_RANGE')
end
local generationId = current.generationId
if generationId == nil then
  generationId = 'legacy:' .. tostring(currentFence) .. ':' .. tostring(tonumber(current.acquiredAtMs))
end
if current.holder ~= ARGV[1] or currentFence ~= requestedFence or generationId ~= ARGV[5] or currentExpiresAtMs <= now then return '' end
if not isSortedSetOrMissing(KEYS[2]) or not isSortedSetOrMissing(KEYS[3]) then
  return redis.error_reply('TVIC_LEASE_INDEX_TYPE')
end
current.renewedAtMs = now
current.expiresAtMs = expiresAtMs
local encoded = cjson.encode(current)
redis.call('ZADD', KEYS[2], math.min(currentExpiresAtMs, expiresAtMs), ARGV[4])
redis.call('SET', KEYS[1], encoded)
redis.call('ZADD', KEYS[2], current.expiresAtMs, ARGV[4])
redis.call('ZREM', KEYS[3], current.sessionId)
return encoded
`;

export const RELEASE_LEASE_SCRIPT = `${SORTED_SET_TYPE_GUARD}${LEASE_NUMERIC_GUARD}
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local current, currentExpiresAtMs, currentFence = readLease(raw)
if not current or current.sessionId ~= ARGV[4] then
  return redis.error_reply('TVIC_LEASE_RECORD_INVALID')
end
local requestedFence = safeInteger(ARGV[2], 1)
if not requestedFence then return redis.error_reply('TVIC_LEASE_FENCE_RANGE') end
local generationId = current.generationId
if generationId == nil then
  generationId = 'legacy:' .. tostring(currentFence) .. ':' .. tostring(tonumber(current.acquiredAtMs))
end
if current.holder ~= ARGV[1] or currentFence ~= requestedFence or generationId ~= ARGV[5] then return 0 end
if not isSortedSetOrMissing(KEYS[2]) or not isSortedSetOrMissing(KEYS[3]) then
  return redis.error_reply('TVIC_LEASE_INDEX_TYPE')
end
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
if not safeTimestamp(now) then return redis.error_reply('TVIC_LEASE_TIMESTAMP_RANGE') end
local generationId = current.generationId
if generationId == nil then
  generationId = 'legacy:' .. tostring(tonumber(current.fence)) .. ':' .. tostring(tonumber(current.acquiredAtMs))
end
if current.recoveryResolvedGenerationId ~= generationId and safeInteger(current.recoveryResolvedFence, 1) ~= currentFence then
  redis.call('ZADD', KEYS[2], now, ARGV[3])
  redis.call('ZREM', KEYS[3], ARGV[4])
  current.renewedAtMs = now
  current.expiresAtMs = now
  redis.call('SET', KEYS[1], cjson.encode(current))
else
  current.renewedAtMs = now
  current.expiresAtMs = now
  redis.call('SET', KEYS[1], cjson.encode(current))
  redis.call('ZREM', KEYS[3], ARGV[4])
  redis.call('ZREM', KEYS[2], ARGV[3])
end
return 1
`;

export const ACK_RECOVERY_CANDIDATE_SCRIPT = `${SORTED_SET_TYPE_GUARD}${LEASE_NUMERIC_GUARD}
local raw = redis.pcall('GET', KEYS[1])
if not raw or type(raw) == 'table' then return 0 end
local current, expiresAtMs, fence = readLease(raw)
local requestedFence = safeInteger(ARGV[2], 1)
if not current or not requestedFence or current.sessionId ~= ARGV[1] or fence ~= requestedFence then
  return 0
end
local generationId = current.generationId
if generationId == nil then
  generationId = 'legacy:' .. tostring(fence) .. ':' .. tostring(tonumber(current.acquiredAtMs))
elseif type(generationId) ~= 'string' then
  return 0
end
if generationId ~= ARGV[3] then return 0 end
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
if not safeTimestamp(now) then return redis.error_reply('TVIC_LEASE_TIMESTAMP_RANGE') end
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

export const LIST_RECOVERY_CANDIDATES_SCRIPT = `${SORTED_SET_TYPE_GUARD}${LEASE_NUMERIC_GUARD}
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
local function decodeKeyPart(value)
  return (string.gsub(value, '%%(%x%x)', function(hex)
    return string.char(tonumber(hex, 16))
  end))
end
local corruptLeaseSessionIds = {}
local corruptLeaseSessionIdsSeen = {}
local function reportCorruptLease(sessionId)
  if not corruptLeaseSessionIdsSeen[sessionId] then
    corruptLeaseSessionIdsSeen[sessionId] = true
    corruptLeaseSessionIds[#corruptLeaseSessionIds + 1] = sessionId
  end
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
    safeInteger(lease.recoveryResolvedFence, 1) == safeInteger(lease.fence, 1)
end
local function readIndexedLease(key)
  local raw = redis.pcall('GET', key)
  if type(raw) ~= 'table' then return raw, false, nil end
  local err = raw.err
  if type(err) == 'string' and string.sub(err, 1, 9) == 'WRONGTYPE' then
    return nil, true, nil
  end
  if type(err) == 'string' then return nil, false, err end
  return nil, false, 'TVIC_LEASE_READ_FAILED'
end
if not isSortedSetOrMissing(KEYS[1]) or not isSortedSetOrMissing(KEYS[2]) then
  return redis.error_reply('TVIC_LEASE_INDEX_TYPE')
end
local min = '-'
if ARGV[1] == '1' then min = '(' .. ARGV[2] end
local limit = tonumber(ARGV[3])
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
if not safeTimestamp(now) then return redis.error_reply('TVIC_LEASE_TIMESTAMP_RANGE') end
local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now, 'LIMIT', 0, limit + 1)
local dueCount = math.min(#due, limit)
local initialMembers = redis.call('ZRANGEBYLEX', KEYS[2], min, '+', 'LIMIT', 0, limit + 1)
local indexedLeaseCache = {}
local function preloadIndexedLease(encodedId)
  local key = ARGV[4] .. encodedId
  if indexedLeaseCache[key] then return nil end
  local raw, wrongType, readError = readIndexedLease(key)
  if readError then return readError end
  indexedLeaseCache[key] = {raw = raw, wrongType = wrongType}
  return nil
end
for index = 1, dueCount do
  local readError = preloadIndexedLease(due[index])
  if readError then return redis.error_reply(readError) end
end
for index = 1, math.min(#initialMembers, limit) do
  local readError = preloadIndexedLease(encodeKeyPart(initialMembers[index]))
  if readError then return redis.error_reply(readError) end
end
for index = 1, dueCount do
  local encodedId = due[index]
  local indexedLease = indexedLeaseCache[ARGV[4] .. encodedId]
  local raw = indexedLease.raw
  local wrongType = indexedLease.wrongType
  if raw then
    local lease, expiresAtMs = readLease(raw)
    local generationId = lease and leaseGenerationId(lease)
    if lease and generationId and encodeKeyPart(lease.sessionId) == encodedId then
      if recoveryResolved(lease, generationId) then
        redis.call('ZREM', KEYS[1], encodedId)
      elseif expiresAtMs <= now then
        redis.call('ZADD', KEYS[2], 0, lease.sessionId)
        redis.call('ZREM', KEYS[1], encodedId)
      else
        redis.call('ZADD', KEYS[1], expiresAtMs, encodedId)
      end
    else
      reportCorruptLease(decodeKeyPart(encodedId))
      redis.call('ZREM', KEYS[1], encodedId)
    end
  else
    if wrongType then reportCorruptLease(decodeKeyPart(encodedId)) end
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
  local indexedLease = indexedLeaseCache[ARGV[4] .. encodeKeyPart(sessionId)]
  if not indexedLease then return redis.error_reply('TVIC_LEASE_PREFLIGHT_MISSED') end
  local raw = indexedLease.raw
  local wrongType = indexedLease.wrongType
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
      else
        reportCorruptLease(sessionId)
      end
      redis.call('ZREM', KEYS[2], sessionId)
    end
  else
    if wrongType then reportCorruptLease(sessionId) end
    redis.call('ZREM', KEYS[2], sessionId)
  end
end
local lastExamined = ''
if inspected > 0 then lastExamined = members[inspected] end
return {candidates, candidateFences, candidateGenerationIds, lastExamined, #members > limit and 1 or 0, inspected, #due > limit and 1 or 0, corruptLeaseSessionIds}
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
    try {
      return {
        provided: true,
        sessionId: decodeKeyPart(cursor.slice(`${RECOVERY_CURSOR_PREFIX}id:`.length)),
      };
    } catch {
      throw new InvalidArgumentError("Invalid Redis recovery cursor");
    }
  }
  return { provided: true, sessionId: cursor };
}

export const PREPARE_SESSION_LEASE_SCRIPT = `${SORTED_SET_TYPE_GUARD}${LEASE_NUMERIC_GUARD}
local existingRaw = redis.call('GET', KEYS[1])
if existingRaw and existingRaw ~= ARGV[1] then return -1 end
local leaseRaw = redis.call('GET', KEYS[3])
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local expiresAtMs = safeLeaseExpiry(now, ARGV[4])
if not expiresAtMs then return redis.error_reply('TVIC_LEASE_EXPIRY_RANGE') end
local current, currentExpiresAtMs, currentFence = nil, nil, nil
if leaseRaw then
  current, currentExpiresAtMs, currentFence = readLease(leaseRaw)
  if not current or current.sessionId ~= ARGV[3] then
    return redis.error_reply('TVIC_LEASE_RECORD_INVALID')
  end
end
if current and currentExpiresAtMs > now then
  if current.holder ~= ARGV[2] then return 0 end
  if not isSortedSetOrMissing(KEYS[4]) or not isSortedSetOrMissing(KEYS[5]) then
    return redis.error_reply('TVIC_LEASE_INDEX_TYPE')
  end
  redis.call('ZADD', KEYS[4], currentExpiresAtMs, ARGV[5])
  redis.call('ZREM', KEYS[5], ARGV[3])
  return {'reused', leaseRaw}
end
if not isSortedSetOrMissing(KEYS[4]) or not isSortedSetOrMissing(KEYS[5]) then
  return redis.error_reply('TVIC_LEASE_INDEX_TYPE')
end
if currentFence and currentFence >= MAX_SAFE_INTEGER then
  return redis.error_reply('TVIC_LEASE_FENCE_RANGE')
end
local lease = {
  sessionId = ARGV[3],
  holder = ARGV[2],
  fence = currentFence and currentFence + 1 or 1,
  generationId = ARGV[6],
  acquiredAtMs = now,
  renewedAtMs = now,
  expiresAtMs = expiresAtMs
}
local encoded = cjson.encode(lease)
if current then
  redis.call('ZADD', KEYS[4], currentExpiresAtMs, ARGV[5])
  redis.call('SET', KEYS[3], encoded)
  redis.call('ZADD', KEYS[4], lease.expiresAtMs, ARGV[5])
else
  redis.call('ZADD', KEYS[4], lease.expiresAtMs, ARGV[5])
  redis.call('SET', KEYS[3], encoded)
end
redis.call('ZREM', KEYS[5], ARGV[3])
return {'prepared', encoded}
`;

export const FINALIZE_SESSION_CREATION_SCRIPT = `${SORTED_SET_TYPE_GUARD}${LEASE_NUMERIC_GUARD}
local leaseRaw = redis.call('GET', KEYS[3])
if not leaseRaw then return 0 end
local lease, expiresAtMs, leaseFence = readLease(leaseRaw)
local requestedFence = safeInteger(ARGV[4], 1)
if not lease or not requestedFence then return redis.error_reply('TVIC_LEASE_RECORD_INVALID') end
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
if not safeTimestamp(now) then return redis.error_reply('TVIC_LEASE_TIMESTAMP_RANGE') end
local generationId = lease.generationId
if generationId == nil then
  generationId = 'legacy:' .. tostring(leaseFence) .. ':' .. tostring(tonumber(lease.acquiredAtMs))
end
if lease.sessionId ~= ARGV[3] or lease.holder ~= ARGV[2] or leaseFence ~= requestedFence or generationId ~= ARGV[9] or expiresAtMs <= now then return 0 end
local existingRaw = redis.call('GET', KEYS[1])
if existingRaw and existingRaw ~= ARGV[1] then return -1 end
local score = tonumber(ARGV[7])
if not score or score ~= score or score == math.huge or score == -math.huge then
  return redis.error_reply('TVIC_RECORD_INDEX_SCORE')
end
if not isSortedSetOrMissing(KEYS[2]) then
  return redis.error_reply('TVIC_RECORD_INDEX_TYPE')
end
redis.call('ZADD', KEYS[2], ARGV[7], KEYS[1])
if ARGV[5] ~= '' then
  redis.call('MSET', KEYS[1], ARGV[1], ARGV[6], ARGV[5])
else
  redis.call('SET', KEYS[1], ARGV[1])
end
return 1
`;
