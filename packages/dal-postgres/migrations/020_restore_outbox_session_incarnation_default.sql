BEGIN;

-- Migration 009 added this default so older writers can omit the column. Keep
-- it explicit in a forward migration for databases that already recorded an
-- earlier version of migration 009 without the default.
ALTER TABLE tvic_outbox
  ALTER COLUMN session_incarnation SET DEFAULT 0;

COMMIT;
