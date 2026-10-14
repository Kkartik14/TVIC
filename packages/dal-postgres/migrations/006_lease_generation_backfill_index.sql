CREATE INDEX CONCURRENTLY IF NOT EXISTS tvic_session_leases_generation_backfill_idx
  ON tvic_session_leases (expires_at_ms, session_id)
  WHERE generation_id IS NULL
    AND recovery_acknowledged_fence IS DISTINCT FROM fence;
