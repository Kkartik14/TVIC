BEGIN;

ALTER TABLE tvic_outbox DROP CONSTRAINT IF EXISTS tvic_outbox_session_id_fkey;
ALTER TABLE tvic_outbox
  ADD CONSTRAINT tvic_outbox_session_id_fkey
  FOREIGN KEY (session_id) REFERENCES tvic_sessions (id) ON DELETE RESTRICT;

COMMIT;
