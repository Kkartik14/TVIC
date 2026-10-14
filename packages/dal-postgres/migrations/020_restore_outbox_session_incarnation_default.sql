BEGIN;

ALTER TABLE tvic_outbox
  ALTER COLUMN session_incarnation SET DEFAULT 0;

COMMIT;
