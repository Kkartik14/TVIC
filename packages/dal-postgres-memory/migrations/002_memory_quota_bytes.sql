BEGIN;

-- Migration 001 may already be recorded on an installation whose table was
-- created before session quotas existed. Add the persisted accounting column
-- separately so those installations receive the same invariant as fresh ones.
ALTER TABLE tvic_memory_entries
  ADD COLUMN IF NOT EXISTS value_bytes bigint;

-- PostgreSQL jsonb has one canonical text representation. Convert that text to
-- UTF-8 explicitly so quota accounting is independent of the database's
-- server encoding, and backfill rows written before the column existed.
UPDATE tvic_memory_entries
   SET value_bytes = octet_length(convert_to(value::text, 'UTF8'));

ALTER TABLE tvic_memory_entries
  ALTER COLUMN value_bytes DROP DEFAULT,
  ALTER COLUMN value_bytes SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'tvic_memory_entries'::regclass
       AND conname = 'tvic_memory_entries_value_bytes_check'
  ) THEN
    ALTER TABLE tvic_memory_entries
      ADD CONSTRAINT tvic_memory_entries_value_bytes_check
      CHECK (value_bytes >= 0);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION tvic_memory_entries_set_value_bytes()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.value_bytes := octet_length(convert_to(NEW.value::text, 'UTF8'));
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tvic_memory_entries_value_bytes_trigger ON tvic_memory_entries;

CREATE TRIGGER tvic_memory_entries_value_bytes_trigger
BEFORE INSERT OR UPDATE ON tvic_memory_entries
FOR EACH ROW EXECUTE FUNCTION tvic_memory_entries_set_value_bytes();

COMMIT;
