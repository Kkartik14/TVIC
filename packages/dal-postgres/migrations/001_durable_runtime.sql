BEGIN;

CREATE TABLE IF NOT EXISTS tvic_sessions (
  id text PRIMARY KEY,
  agent_id text NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL,
  started_at timestamptz,
  ended_at timestamptz,
  payload jsonb NOT NULL,
  runtime jsonb NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  last_fence bigint NOT NULL DEFAULT 0,
  last_activity_at timestamptz NOT NULL,
  recovery_deadline_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tvic_sessions_activity_idx
  ON tvic_sessions (last_activity_at, id);

CREATE INDEX IF NOT EXISTS tvic_sessions_recovery_idx
  ON tvic_sessions (recovery_deadline_at, id)
  WHERE status IN ('active', 'interrupted', 'waiting_for_tool', 'ending');

CREATE TABLE IF NOT EXISTS tvic_turns (
  session_id text NOT NULL REFERENCES tvic_sessions (id) ON DELETE CASCADE,
  id text NOT NULL,
  turn_sequence integer NOT NULL,
  status text NOT NULL,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  payload jsonb NOT NULL,
  runtime jsonb NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  last_fence bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, id),
  UNIQUE (session_id, turn_sequence)
);

CREATE INDEX IF NOT EXISTS tvic_turns_session_order_idx
  ON tvic_turns (session_id, turn_sequence, id);

CREATE TABLE IF NOT EXISTS tvic_tool_calls (
  session_id text NOT NULL REFERENCES tvic_sessions (id) ON DELETE CASCADE,
  id text NOT NULL,
  turn_id text NOT NULL,
  status text NOT NULL,
  queued_at timestamptz NOT NULL,
  started_at timestamptz,
  ended_at timestamptz,
  payload jsonb NOT NULL,
  runtime jsonb NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  last_fence bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, id),
  FOREIGN KEY (session_id, turn_id)
    REFERENCES tvic_turns (session_id, id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS tvic_tool_calls_session_order_idx
  ON tvic_tool_calls (session_id, queued_at, id);

CREATE INDEX IF NOT EXISTS tvic_tool_calls_status_idx
  ON tvic_tool_calls (status, updated_at, session_id);

CREATE TABLE IF NOT EXISTS tvic_session_leases (
  session_id text PRIMARY KEY REFERENCES tvic_sessions (id) ON DELETE CASCADE,
  holder text NOT NULL,
  fence bigint NOT NULL,
  acquired_at_ms bigint NOT NULL,
  renewed_at_ms bigint NOT NULL,
  expires_at_ms bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tvic_session_leases_expiry_idx
  ON tvic_session_leases (expires_at_ms, session_id);

CREATE TABLE IF NOT EXISTS tvic_tool_idempotency (
  key text PRIMARY KEY,
  tool_id text,
  tool_version text,
  session_id text,
  turn_id text,
  tool_call_id text,
  request_hash text NOT NULL,
  status text NOT NULL,
  owner text,
  claimed_fence bigint,
  claimed_at_ms bigint,
  expires_at_ms bigint NOT NULL,
  output jsonb,
  error jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE tvic_tool_idempotency
  ADD COLUMN IF NOT EXISTS session_id text,
  ADD COLUMN IF NOT EXISTS claimed_fence bigint,
  ADD COLUMN IF NOT EXISTS tool_id text,
  ADD COLUMN IF NOT EXISTS tool_version text;

CREATE INDEX IF NOT EXISTS tvic_tool_idempotency_expiry_idx
  ON tvic_tool_idempotency (expires_at_ms, key);

CREATE TABLE IF NOT EXISTS tvic_outbox (
  id text PRIMARY KEY,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  session_id text NOT NULL REFERENCES tvic_sessions (id) ON DELETE RESTRICT,
  version bigint NOT NULL,
  fence bigint NOT NULL,
  envelope jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  claimed_by text,
  claim_expires_at timestamptz,
  delivered_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  last_error jsonb
);

CREATE INDEX IF NOT EXISTS tvic_outbox_pending_idx
  ON tvic_outbox (created_at, id)
  WHERE delivered_at IS NULL;

CREATE INDEX IF NOT EXISTS tvic_outbox_claim_idx
  ON tvic_outbox (claim_expires_at, created_at, id)
  WHERE delivered_at IS NULL;

COMMIT;
