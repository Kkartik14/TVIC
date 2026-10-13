BEGIN;

-- Session IDs can be reused after retention deletes a session. Keep a durable
-- ordering token so delayed cache events from the earlier record cannot win.
CREATE SEQUENCE IF NOT EXISTS tvic_session_incarnation_seq AS bigint;

-- Existing rows are legacy incarnation zero. Adding the constant default avoids
-- a row-by-row rewrite on supported PostgreSQL versions. New rows get sequence
-- values after this migration commits.
ALTER TABLE tvic_sessions
  ADD COLUMN IF NOT EXISTS incarnation bigint NOT NULL DEFAULT 0;

ALTER TABLE tvic_sessions
  ALTER COLUMN incarnation SET DEFAULT nextval('tvic_session_incarnation_seq');

COMMENT ON COLUMN tvic_sessions.incarnation IS
  'Monotonic session lifetime; zero identifies sessions present before migration 009.';

-- Old application versions omit session_incarnation on outbox inserts. The
-- default keeps those inserts valid; the trigger resolves the value from the
-- referenced session so events from newly-created sessions retain their order.
ALTER TABLE tvic_outbox
  ADD COLUMN IF NOT EXISTS session_incarnation bigint NOT NULL DEFAULT 0;

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
