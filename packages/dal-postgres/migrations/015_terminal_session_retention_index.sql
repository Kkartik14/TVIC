-- Retention pages terminal sessions by ended_at and ID.
-- Build this index concurrently because the session table can be populated.
CREATE INDEX CONCURRENTLY IF NOT EXISTS tvic_sessions_terminal_retention_idx
  ON tvic_sessions (ended_at, id)
  WHERE status IN ('completed', 'failed', 'cancelled');
