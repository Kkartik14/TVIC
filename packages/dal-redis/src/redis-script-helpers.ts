export const SORTED_SET_TYPE_GUARD = `
local function isSortedSetOrMissing(key)
  local keyType = redis.call('TYPE', key).ok
  return keyType == 'none' or keyType == 'zset'
end
`;

export const LEASE_NUMERIC_GUARD = `
local MAX_SAFE_INTEGER = 9007199254740991
local function safeInteger(value, minimum)
  if type(value) ~= 'number' and type(value) ~= 'string' then return nil end
  if type(value) == 'string' then
    if not string.match(value, '^%d+$') or (#value > 1 and string.sub(value, 1, 1) == '0') then
      return nil
    end
  end
  local numeric = tonumber(value)
  if not numeric or numeric ~= numeric or numeric == math.huge or numeric == -math.huge or
    numeric < minimum or numeric > MAX_SAFE_INTEGER or numeric % 1 ~= 0 then
    return nil
  end
  return numeric
end
local function exactIntegerString(value, minimum)
  local integer = safeInteger(value, minimum)
  if not integer then return nil end
  return string.format('%.0f', integer)
end
local function safeTimestamp(value)
  return safeInteger(value, 0)
end
local function readLease(raw)
  local ok, lease = pcall(cjson.decode, raw)
  if not ok or type(lease) ~= 'table' or
    type(lease.sessionId) ~= 'string' or #lease.sessionId == 0 or
    type(lease.holder) ~= 'string' then
    return nil, nil, nil
  end
  if (type(lease.fence) ~= 'number' and type(lease.fence) ~= 'string') or
    (type(lease.acquiredAtMs) ~= 'number' and type(lease.acquiredAtMs) ~= 'string') or
    (type(lease.renewedAtMs) ~= 'number' and type(lease.renewedAtMs) ~= 'string') or
    (type(lease.expiresAtMs) ~= 'number' and type(lease.expiresAtMs) ~= 'string') then
    return nil, nil, nil
  end
  local fence = safeInteger(lease.fence, 1)
  local acquiredAtMs = safeTimestamp(lease.acquiredAtMs)
  local renewedAtMs = safeTimestamp(lease.renewedAtMs)
  local expiresAtMs = safeTimestamp(lease.expiresAtMs)
  if not fence or not acquiredAtMs or not renewedAtMs or not expiresAtMs or
    (lease.generationId ~= nil and
      (type(lease.generationId) ~= 'string' or #lease.generationId == 0)) or
    (lease.recoveryResolvedFence ~= nil and
      ((type(lease.recoveryResolvedFence) ~= 'number' and
        type(lease.recoveryResolvedFence) ~= 'string') or
        not safeInteger(lease.recoveryResolvedFence, 1))) or
    (lease.recoveryResolvedGenerationId ~= nil and
      (type(lease.recoveryResolvedGenerationId) ~= 'string' or
        #lease.recoveryResolvedGenerationId == 0)) then
    return nil, nil, nil
  end
  lease.fence = fence
  lease.acquiredAtMs = acquiredAtMs
  lease.renewedAtMs = renewedAtMs
  lease.expiresAtMs = expiresAtMs
  if lease.recoveryResolvedFence ~= nil then
    lease.recoveryResolvedFence = safeInteger(lease.recoveryResolvedFence, 1)
  end
  return lease, expiresAtMs, fence
end
local function encodeLease(lease)
  local encodedLease = {}
  for key, value in pairs(lease) do encodedLease[key] = value end
  encodedLease.fence = exactIntegerString(lease.fence, 1)
  encodedLease.acquiredAtMs = exactIntegerString(lease.acquiredAtMs, 0)
  encodedLease.renewedAtMs = exactIntegerString(lease.renewedAtMs, 0)
  encodedLease.expiresAtMs = exactIntegerString(lease.expiresAtMs, 0)
  if lease.recoveryResolvedFence ~= nil then
    encodedLease.recoveryResolvedFence = exactIntegerString(lease.recoveryResolvedFence, 1)
  end
  if not encodedLease.fence or not encodedLease.acquiredAtMs or
    not encodedLease.renewedAtMs or not encodedLease.expiresAtMs or
    (lease.recoveryResolvedFence ~= nil and not encodedLease.recoveryResolvedFence) then
    return nil
  end
  return cjson.encode(encodedLease)
end
local function safeLeaseExpiry(now, ttl)
  local safeNow = safeTimestamp(now)
  local safeTtl = safeInteger(ttl, 1)
  if not safeNow or not safeTtl or safeTtl > MAX_SAFE_INTEGER - safeNow then return nil end
  return safeNow + safeTtl
end
`;

export const IDEMPOTENCY_RECORD_GUARD = `
local function readIdempotencyRecord(raw, expectedKey)
  local ok, record = pcall(cjson.decode, raw)
  if not ok or type(record) ~= 'table' then return nil, nil end
  if type(record.key) ~= 'string' or record.key ~= expectedKey then return nil, nil end
  if type(record.expiresAtMs) ~= 'number' then return nil, nil end
  local expiresAtMs = safeTimestamp(record.expiresAtMs)
  if not expiresAtMs then return nil, nil end
  if record.claimedFence ~= nil then
    if type(record.claimedFence) ~= 'number' and type(record.claimedFence) ~= 'string' then return nil, nil end
    record.claimedFence = safeInteger(record.claimedFence, 1)
    if not record.claimedFence then return nil, nil end
  end
  if record.claimedGenerationId ~= nil and
    (type(record.claimedGenerationId) ~= 'string' or #record.claimedGenerationId == 0) then
    return nil, nil
  end
  return record, expiresAtMs
end
local function encodeIdempotencyRecord(record)
  local encodedRecord = {}
  for key, value in pairs(record) do encodedRecord[key] = value end
  if record.claimedFence ~= nil then
    encodedRecord.claimedFence = exactIntegerString(record.claimedFence, 1)
    if not encodedRecord.claimedFence then return nil end
  end
  return cjson.encode(encodedRecord)
end
`;
