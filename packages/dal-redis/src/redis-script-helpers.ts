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
  local numeric = tonumber(value)
  if not numeric or numeric ~= numeric or numeric == math.huge or numeric == -math.huge or
    numeric < minimum or numeric > MAX_SAFE_INTEGER or numeric % 1 ~= 0 then
    return nil
  end
  return numeric
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
  if type(lease.fence) ~= 'number' or
    type(lease.acquiredAtMs) ~= 'number' or
    type(lease.renewedAtMs) ~= 'number' or
    type(lease.expiresAtMs) ~= 'number' then
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
      (type(lease.recoveryResolvedFence) ~= 'number' or
        not safeInteger(lease.recoveryResolvedFence, 1))) or
    (lease.recoveryResolvedGenerationId ~= nil and
      (type(lease.recoveryResolvedGenerationId) ~= 'string' or
        #lease.recoveryResolvedGenerationId == 0)) then
    return nil, nil, nil
  end
  return lease, expiresAtMs, fence
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
    if type(record.claimedFence) ~= 'number' or not safeInteger(record.claimedFence, 1) then
      return nil, nil
    end
  end
  if record.claimedGenerationId ~= nil and
    (type(record.claimedGenerationId) ~= 'string' or #record.claimedGenerationId == 0) then
    return nil, nil
  end
  return record, expiresAtMs
end
`;
