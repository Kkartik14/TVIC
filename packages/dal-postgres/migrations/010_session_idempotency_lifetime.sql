BEGIN;

-- Idempotency results intentionally outlive terminal sessions. When an ID is
-- inserted again after retention, discard results belonging to its old life.
-- Keeping this rule in PostgreSQL also covers older and unfenced writers.
CREATE OR REPLACE FUNCTION tvic_clear_session_tool_idempotency()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM tvic_tool_idempotency WHERE session_id = NEW.id;
  RETURN NEW;
END;
$$;

-- The trigger is installed in migration 014 after its session_id index exists.

COMMIT;
