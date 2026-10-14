CREATE INDEX CONCURRENTLY IF NOT EXISTS tvic_outbox_delivered_at_idx
  ON tvic_outbox (delivered_at)
  WHERE delivered_at IS NOT NULL;
