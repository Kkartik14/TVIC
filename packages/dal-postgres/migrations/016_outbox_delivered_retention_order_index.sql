-- Retention deletes old delivered events in deterministic bounded batches.
CREATE INDEX CONCURRENTLY IF NOT EXISTS tvic_outbox_delivered_retention_idx
  ON tvic_outbox (delivered_at, id)
  WHERE delivered_at IS NOT NULL;
