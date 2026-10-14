BEGIN;

-- Some databases recorded migration 009 before its outbox compatibility
-- trigger existed. Restore the behavior in a forward migration so legacy
-- writers that omit session_incarnation remain ordered across session reuse.
CREATE SEQUENCE IF NOT EXISTS tvic_session_incarnation_seq AS bigint;

ALTER TABLE tvic_sessions
  ADD COLUMN IF NOT EXISTS incarnation bigint NOT NULL DEFAULT 0;

ALTER TABLE tvic_sessions
  ALTER COLUMN incarnation SET DEFAULT nextval('tvic_session_incarnation_seq');

ALTER TABLE tvic_outbox
  ADD COLUMN IF NOT EXISTS session_incarnation bigint NOT NULL DEFAULT 0;

ALTER TABLE tvic_outbox
  ALTER COLUMN session_incarnation SET DEFAULT 0;

CREATE OR REPLACE FUNCTION tvic_set_outbox_session_incarnation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_incarnation bigint;
BEGIN
  IF NEW.session_id IS NOT NULL AND NEW.session_incarnation = 0 THEN
    SELECT incarnation
      INTO current_incarnation
      FROM tvic_sessions
      WHERE id = NEW.session_id;
    IF FOUND THEN
      NEW.session_incarnation := current_incarnation;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tvic_outbox_session_incarnation_trigger ON tvic_outbox;
CREATE TRIGGER tvic_outbox_session_incarnation_trigger
  BEFORE INSERT ON tvic_outbox
  FOR EACH ROW
  EXECUTE FUNCTION tvic_set_outbox_session_incarnation();

COMMIT;
