import { IDEMPOTENCY_RECORD_GUARD, LEASE_NUMERIC_GUARD } from "./redis-script-helpers.js";

export const FENCED_CLAIM_SCRIPT = `${LEASE_NUMERIC_GUARD}${IDEMPOTENCY_RECORD_GUARD}
local leaseRaw = redis.call('GET', KEYS[1])
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
if not safeTimestamp(now) then return redis.error_reply('TVIC_LEASE_TIMESTAMP_RANGE') end
local claimExpiresAtMs = safeLeaseExpiry(now, ARGV[9])
if not claimExpiresAtMs then return redis.error_reply('TVIC_LEASE_EXPIRY_RANGE') end
if not leaseRaw then return {-1, ''} end
local lease, leaseExpiresAtMs, leaseFence = readLease(leaseRaw)
local requestedFence = safeInteger(ARGV[2], 1)
if not lease or not requestedFence then return redis.error_reply('TVIC_LEASE_RECORD_INVALID') end
if lease.sessionId ~= ARGV[4] then return {-1, ''} end
local generationId = lease.generationId
if generationId == nil then
  generationId = 'legacy:' .. tostring(leaseFence) .. ':' .. tostring(tonumber(lease.acquiredAtMs))
end
if lease.holder ~= ARGV[1] or leaseFence ~= requestedFence or generationId ~= ARGV[10] or leaseExpiresAtMs <= now then
  return {-1, ''}
end
local currentRaw = redis.call('GET', KEYS[2])
if currentRaw then
  local current, currentExpiresAtMs = readIdempotencyRecord(currentRaw, ARGV[3])
  if not current then return redis.error_reply('TVIC_IDEMPOTENCY_RECORD_INVALID') end
  if currentExpiresAtMs > now then
    if (ARGV[5] ~= '' and current.toolId ~= nil and current.toolId ~= ARGV[5]) or
       (ARGV[6] ~= '' and current.toolVersion ~= nil and current.toolVersion ~= ARGV[6]) or
       current.requestHash ~= ARGV[7] or
       (ARGV[4] ~= '' and (current.sessionId == nil or current.sessionId ~= ARGV[4])) then
      return {-2, currentRaw}
    end
    if current.status == 'succeeded' then return {2, currentRaw} end
    if current.status == 'claimed' then
      local stale = false
      if ARGV[4] ~= '' and current.sessionId ~= nil and current.sessionId == ARGV[4] then
        if current.claimedGenerationId ~= nil then
          stale = current.claimedGenerationId ~= ARGV[10]
        else
          stale = current.claimedFence ~= nil and current.claimedFence < requestedFence
        end
      end
      if not stale then return {0, currentRaw} end
    else
      return {3, currentRaw}
    end
  end
end
local next = {
  key = ARGV[3],
  requestHash = ARGV[7],
  status = 'claimed',
  owner = ARGV[8],
  expiresAtMs = claimExpiresAtMs
}
if ARGV[4] ~= '' then
  next.sessionId = ARGV[4]
  next.claimedFence = tonumber(ARGV[2])
  next.claimedGenerationId = ARGV[10]
end
if ARGV[5] ~= '' then next.toolId = ARGV[5] end
if ARGV[6] ~= '' then next.toolVersion = ARGV[6] end
local encoded = cjson.encode(next)
redis.call('SET', KEYS[2], encoded, 'PX', ARGV[9])
return {1, encoded}
`;

export const UNFENCED_CLAIM_SCRIPT = `${LEASE_NUMERIC_GUARD}${IDEMPOTENCY_RECORD_GUARD}
local sessionId = ARGV[2]
if sessionId ~= '' and (redis.call('EXISTS', KEYS[1]) == 1 or redis.call('EXISTS', KEYS[2]) == 1) then
  return {-2, ''}
end
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
if not safeTimestamp(now) then return redis.error_reply('TVIC_LEASE_TIMESTAMP_RANGE') end
local claimExpiresAtMs = safeLeaseExpiry(now, ARGV[7])
if not claimExpiresAtMs then return redis.error_reply('TVIC_LEASE_EXPIRY_RANGE') end
local currentRaw = redis.call('GET', KEYS[3])
if currentRaw then
  local current, currentExpiresAtMs = readIdempotencyRecord(currentRaw, ARGV[1])
  if not current then return redis.error_reply('TVIC_IDEMPOTENCY_RECORD_INVALID') end
  if currentExpiresAtMs > now then
    local expectedSessionId = sessionId ~= '' and sessionId or nil
    if current.sessionId ~= expectedSessionId or
       (ARGV[3] ~= '' and current.toolId ~= nil and current.toolId ~= ARGV[3]) or
       (ARGV[4] ~= '' and current.toolVersion ~= nil and current.toolVersion ~= ARGV[4]) or
       current.requestHash ~= ARGV[5] then
      return {-2, currentRaw}
    end
    if current.status == 'succeeded' then return {2, currentRaw} end
    if current.status == 'claimed' then return {0, currentRaw} end
    return {3, currentRaw}
  end
end
local next = {
  key = ARGV[1],
  requestHash = ARGV[5],
  status = 'claimed',
  owner = ARGV[6],
  expiresAtMs = claimExpiresAtMs
}
if sessionId ~= '' then next.sessionId = sessionId end
if ARGV[3] ~= '' then next.toolId = ARGV[3] end
if ARGV[4] ~= '' then next.toolVersion = ARGV[4] end
local encoded = cjson.encode(next)
redis.call('SET', KEYS[3], encoded, 'PX', ARGV[7])
return {1, encoded}
`;

export const FENCED_COMPLETE_SCRIPT = `${LEASE_NUMERIC_GUARD}${IDEMPOTENCY_RECORD_GUARD}
local leaseRaw = redis.call('GET', KEYS[1])
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
if not safeTimestamp(now) then return redis.error_reply('TVIC_LEASE_TIMESTAMP_RANGE') end
local completionExpiresAtMs = safeLeaseExpiry(now, ARGV[6])
if not completionExpiresAtMs then return redis.error_reply('TVIC_LEASE_EXPIRY_RANGE') end
if not leaseRaw then return {-1, ''} end
local lease, leaseExpiresAtMs, leaseFence = readLease(leaseRaw)
local requestedFence = safeInteger(ARGV[2], 1)
if not lease or not requestedFence then return redis.error_reply('TVIC_LEASE_RECORD_INVALID') end
if lease.sessionId ~= ARGV[9] then return {-1, ''} end
local generationId = lease.generationId
if generationId == nil then
  generationId = 'legacy:' .. tostring(leaseFence) .. ':' .. tostring(tonumber(lease.acquiredAtMs))
end
if lease.holder ~= ARGV[1] or leaseFence ~= requestedFence or generationId ~= ARGV[10] or leaseExpiresAtMs <= now then
  return {-1, ''}
end
local currentRaw = redis.call('GET', KEYS[2])
if not currentRaw then return {-2, ''} end
local current, currentExpiresAtMs = readIdempotencyRecord(currentRaw, ARGV[11])
if not current then return redis.error_reply('TVIC_IDEMPOTENCY_RECORD_INVALID') end
if currentExpiresAtMs <= now or current.requestHash ~= ARGV[3] or current.owner ~= ARGV[4] or
   (ARGV[9] ~= '' and (current.sessionId == nil or current.sessionId ~= ARGV[9])) or
   (current.claimedFence ~= nil and current.claimedFence ~= requestedFence) or
   (current.claimedGenerationId ~= nil and current.claimedGenerationId ~= ARGV[10]) then
  return {-2, currentRaw}
end
if current.status ~= 'claimed' then return {2, currentRaw} end
current.status = ARGV[5]
current.expiresAtMs = completionExpiresAtMs
current.claimedFence = current.claimedFence or tonumber(ARGV[2])
current.output = nil
current.error = nil
if ARGV[7] == '' then current.outputJson = nil else current.outputJson = ARGV[7] end
if ARGV[8] == '' then current.errorJson = nil else current.errorJson = ARGV[8] end
local encoded = cjson.encode(current)
redis.call('SET', KEYS[2], encoded, 'PX', ARGV[6])
return {1, encoded}
`;

export const UNFENCED_COMPLETE_SCRIPT = `${LEASE_NUMERIC_GUARD}${IDEMPOTENCY_RECORD_GUARD}
local sessionId = ARGV[2]
if sessionId ~= '' and (redis.call('EXISTS', KEYS[1]) == 1 or redis.call('EXISTS', KEYS[2]) == 1) then
  return {-2, ''}
end
local raw = redis.call('GET', KEYS[3])
if not raw then return {-2, ''} end
local current, currentExpiresAtMs = readIdempotencyRecord(raw, ARGV[1])
if not current then return redis.error_reply('TVIC_IDEMPOTENCY_RECORD_INVALID') end
if current.claimedFence ~= nil or current.claimedGenerationId ~= nil then return {-1, raw} end
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
if not safeTimestamp(now) then return redis.error_reply('TVIC_LEASE_TIMESTAMP_RANGE') end
local completionExpiresAtMs = safeLeaseExpiry(now, ARGV[6])
if not completionExpiresAtMs then return redis.error_reply('TVIC_LEASE_EXPIRY_RANGE') end
local expectedSessionId = sessionId ~= '' and sessionId or nil
if currentExpiresAtMs <= now or current.requestHash ~= ARGV[3] or current.owner ~= ARGV[4] or
   current.sessionId ~= expectedSessionId then
  return {-2, raw}
end
if current.status ~= 'claimed' then return {2, raw} end
current.status = ARGV[5]
current.expiresAtMs = completionExpiresAtMs
current.output = nil
current.error = nil
if ARGV[7] == '' then current.outputJson = nil else current.outputJson = ARGV[7] end
if ARGV[8] == '' then current.errorJson = nil else current.errorJson = ARGV[8] end
local encoded = cjson.encode(current)
redis.call('SET', KEYS[3], encoded, 'PX', ARGV[6])
return {1, encoded}
`;

export const QUARANTINE_RECOVERED_IDEMPOTENCY_SCRIPT = `${LEASE_NUMERIC_GUARD}${IDEMPOTENCY_RECORD_GUARD}
local leaseRaw = redis.call('GET', KEYS[1])
if not leaseRaw then return {-1, ''} end
local lease, leaseExpiresAtMs, leaseFence = readLease(leaseRaw)
local requestedFence = safeInteger(ARGV[2], 1)
if not lease or not requestedFence then return redis.error_reply('TVIC_LEASE_RECORD_INVALID') end
if lease.sessionId ~= ARGV[5] then return {-1, ''} end
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
if not safeTimestamp(now) then return redis.error_reply('TVIC_LEASE_TIMESTAMP_RANGE') end
local quarantineExpiresAtMs = safeLeaseExpiry(now, ARGV[10])
if not quarantineExpiresAtMs then return redis.error_reply('TVIC_LEASE_EXPIRY_RANGE') end
local generationId = lease.generationId
if generationId == nil then
  generationId = 'legacy:' .. tostring(leaseFence) .. ':' .. tostring(tonumber(lease.acquiredAtMs))
end
if lease.holder ~= ARGV[1] or leaseFence ~= requestedFence or
   generationId ~= ARGV[3] or leaseExpiresAtMs <= now then
  return {-1, ''}
end
local currentRaw = redis.call('GET', KEYS[2])
if currentRaw then
  local current, currentExpiresAtMs = readIdempotencyRecord(currentRaw, ARGV[4])
  if not current then return redis.error_reply('TVIC_IDEMPOTENCY_RECORD_INVALID') end
  if currentExpiresAtMs > now then
    if current.sessionId ~= ARGV[5] or current.toolId ~= ARGV[6] or
       current.toolVersion ~= ARGV[7] or current.requestHash ~= ARGV[8] then
      return {-2, currentRaw}
    end
    if current.status == 'succeeded' then return {2, currentRaw} end
    if current.status ~= 'claimed' then return {3, currentRaw} end
    if current.owner ~= ARGV[9] then return {0, currentRaw} end
    local priorLease = false
    if current.claimedGenerationId ~= nil then
      priorLease = current.claimedGenerationId ~= ARGV[3]
    elseif current.claimedFence ~= nil then
      priorLease = current.claimedFence < requestedFence
    end
    if not priorLease then return {0, currentRaw} end
  end
end
local next = {
  key = ARGV[4],
  sessionId = ARGV[5],
  toolId = ARGV[6],
  toolVersion = ARGV[7],
  requestHash = ARGV[8],
  status = 'failed',
  owner = ARGV[9],
  claimedFence = tonumber(ARGV[2]),
  claimedGenerationId = ARGV[3],
  expiresAtMs = quarantineExpiresAtMs,
  errorJson = ARGV[11]
}
local encoded = cjson.encode(next)
redis.call('SET', KEYS[2], encoded, 'PX', ARGV[10])
return {1, encoded}
`;

export const FENCED_RELEASE_CLAIM_SCRIPT = `${LEASE_NUMERIC_GUARD}${IDEMPOTENCY_RECORD_GUARD}
local leaseRaw = redis.call('GET', KEYS[1])
if not leaseRaw then return -1 end
local lease, leaseExpiresAtMs, leaseFence = readLease(leaseRaw)
local requestedFence = safeInteger(ARGV[2], 1)
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
if not safeTimestamp(now) then return redis.error_reply('TVIC_LEASE_TIMESTAMP_RANGE') end
if not lease or not requestedFence then return redis.error_reply('TVIC_LEASE_RECORD_INVALID') end
local generationId = lease.generationId
if generationId == nil then
  generationId = 'legacy:' .. tostring(leaseFence) .. ':' .. tostring(tonumber(lease.acquiredAtMs))
end
if lease.sessionId ~= ARGV[4] or lease.holder ~= ARGV[1] or leaseFence ~= requestedFence or
   generationId ~= ARGV[3] or leaseExpiresAtMs <= now then
  return -1
end
local raw = redis.call('GET', KEYS[2])
if not raw then return 0 end
local record, expiresAtMs = readIdempotencyRecord(raw, ARGV[5])
if not record then return redis.error_reply('TVIC_IDEMPOTENCY_RECORD_INVALID') end
if expiresAtMs <= now or record.status ~= 'claimed' or record.requestHash ~= ARGV[6] or
   record.owner ~= ARGV[7] or record.sessionId ~= ARGV[4] or
   (record.claimedFence ~= nil and record.claimedFence ~= requestedFence) or
   (record.claimedGenerationId ~= nil and record.claimedGenerationId ~= ARGV[3]) then
  return 0
end
return redis.call('DEL', KEYS[2])
`;

export const UNFENCED_RELEASE_CLAIM_SCRIPT = `${LEASE_NUMERIC_GUARD}${IDEMPOTENCY_RECORD_GUARD}
if redis.call('EXISTS', KEYS[1]) == 1 or redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
local raw = redis.call('GET', KEYS[3])
if not raw then return 0 end
local record, expiresAtMs = readIdempotencyRecord(raw, ARGV[1])
if not record then return redis.error_reply('TVIC_IDEMPOTENCY_RECORD_INVALID') end
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
if not safeTimestamp(now) then return redis.error_reply('TVIC_LEASE_TIMESTAMP_RANGE') end
if expiresAtMs <= now or record.status ~= 'claimed' or record.requestHash ~= ARGV[2] or
   record.owner ~= ARGV[3] or record.sessionId ~= (ARGV[4] ~= '' and ARGV[4] or nil) or
   record.claimedFence ~= nil or record.claimedGenerationId ~= nil then
  return 0
end
return redis.call('DEL', KEYS[3])
`;

export const REWRITE_ALIAS_ERROR_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if not current or current ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'KEEPTTL')
return 1
`;

export const DELETE_EXPIRED_IDEMPOTENCY_SCRIPT = `${LEASE_NUMERIC_GUARD}${IDEMPOTENCY_RECORD_GUARD}
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local record, expiresAtMs = readIdempotencyRecord(raw, ARGV[1])
if not record then return redis.error_reply('TVIC_IDEMPOTENCY_RECORD_INVALID') end
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
if expiresAtMs <= now then
  redis.call('DEL', KEYS[1])
  return 1
end
return 0
`;

export const UNFENCED_LOOKUP_SCRIPT = `${LEASE_NUMERIC_GUARD}${IDEMPOTENCY_RECORD_GUARD}
local sessionId = ARGV[3]
if sessionId ~= '' and (redis.call('EXISTS', KEYS[1]) == 1 or redis.call('EXISTS', KEYS[2]) == 1) then
  return {-2, ''}
end
local raw = redis.call('GET', KEYS[3])
if not raw then return {0, ''} end
local record, expiresAtMs = readIdempotencyRecord(raw, ARGV[1])
if not record then return redis.error_reply('TVIC_IDEMPOTENCY_RECORD_INVALID') end
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
if not safeTimestamp(now) then return redis.error_reply('TVIC_LEASE_TIMESTAMP_RANGE') end
if expiresAtMs <= now then return {2, ''} end
local expectedSessionId = sessionId ~= '' and sessionId or nil
if record.requestHash ~= ARGV[2] or record.sessionId ~= expectedSessionId then
  return {-2, ''}
end
return {1, raw}
`;

export const FENCED_LOOKUP_SCRIPT = `${LEASE_NUMERIC_GUARD}${IDEMPOTENCY_RECORD_GUARD}
local leaseRaw = redis.call('GET', KEYS[1])
if not leaseRaw then return {-1, ''} end
local lease, leaseExpiresAtMs, leaseFence = readLease(leaseRaw)
local requestedFence = safeInteger(ARGV[3], 1)
if not lease or not requestedFence then return redis.error_reply('TVIC_LEASE_RECORD_INVALID') end
local generationId = lease.generationId
if generationId == nil then
  generationId = 'legacy:' .. tostring(leaseFence) .. ':' .. tostring(tonumber(lease.acquiredAtMs))
end
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
if not safeTimestamp(now) then return redis.error_reply('TVIC_LEASE_TIMESTAMP_RANGE') end
if lease.sessionId ~= ARGV[1] or lease.holder ~= ARGV[2] or leaseFence ~= requestedFence or
   generationId ~= ARGV[4] or leaseExpiresAtMs <= now then
  return {-1, ''}
end
local raw = redis.call('GET', KEYS[2])
if not raw then return {0, ''} end
local record, expiresAtMs = readIdempotencyRecord(raw, ARGV[5])
if not record then return redis.error_reply('TVIC_IDEMPOTENCY_RECORD_INVALID') end
if expiresAtMs <= now then return {2, ''} end
if record.requestHash ~= ARGV[6] or record.sessionId ~= ARGV[1] then
  return {-2, ''}
end
return {1, raw}
`;
