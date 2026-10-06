BEGIN;

-- Nullable columns keep this additive step metadata-only on large lease tables.
-- Existing rows receive identities in bounded batches as they are read or reaped.
ALTER TABLE tvic_session_leases
  ADD COLUMN IF NOT EXISTS generation_id uuid,
  ADD COLUMN IF NOT EXISTS recovery_acknowledged_generation_id uuid;

ALTER TABLE tvic_tool_idempotency
  ADD COLUMN IF NOT EXISTS claimed_generation_id text;

CREATE OR REPLACE FUNCTION tvic_assign_session_lease_generation_id()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.fence IS DISTINCT FROM OLD.fence THEN
    IF NEW.generation_id IS NULL OR NEW.generation_id = OLD.generation_id THEN
      NEW.generation_id := gen_random_uuid();
    END IF;
    NEW.recovery_acknowledged_fence := NULL;
    NEW.recovery_acknowledged_generation_id := NULL;
  END IF;
  IF NEW.generation_id IS NULL THEN
    NEW.generation_id := gen_random_uuid();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tvic_session_lease_generation_id_trigger ON tvic_session_leases;
CREATE TRIGGER tvic_session_lease_generation_id_trigger
  BEFORE INSERT OR UPDATE ON tvic_session_leases
  FOR EACH ROW
  EXECUTE FUNCTION tvic_assign_session_lease_generation_id();

COMMIT;
