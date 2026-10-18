BEGIN;

CREATE OR REPLACE FUNCTION tvic_clear_session_tool_idempotency()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM tvic_tool_idempotency WHERE session_id = NEW.id;
  RETURN NEW;
END;
$$;


COMMIT;
