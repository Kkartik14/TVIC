-- Build the recovery index without blocking lease writes on populated tables.
CREATE INDEX CONCURRENTLY IF NOT EXISTS tvic_session_leases_recovery_expiry_idx
  ON tvic_session_leases (expires_at_ms, session_id)
  WHERE recovery_acknowledged_fence IS DISTINCT FROM fence;
