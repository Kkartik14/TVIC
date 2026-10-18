CREATE INDEX CONCURRENTLY IF NOT EXISTS tvic_sessions_terminal_retention_idx
  ON tvic_sessions (ended_at, id)
  WHERE status IN ('completed', 'failed', 'cancelled');
