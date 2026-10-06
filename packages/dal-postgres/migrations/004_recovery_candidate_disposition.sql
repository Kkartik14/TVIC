BEGIN;

ALTER TABLE tvic_session_leases
  ADD COLUMN IF NOT EXISTS recovery_acknowledged_fence bigint;

COMMIT;
