ALTER TABLE analytics_identities
  ADD COLUMN deletion_token_hash TEXT;

CREATE TABLE analytics_deletion_requests (
  request_id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  posthog_state TEXT NOT NULL DEFAULT 'pending' CHECK (
    posthog_state IN ('pending', 'completed', 'blocked')
  ),
  posthog_attempts INTEGER NOT NULL DEFAULT 0,
  posthog_last_error_class TEXT,
  completed_at TEXT
);

CREATE INDEX analytics_deletion_requests_posthog_queue
  ON analytics_deletion_requests (posthog_state, requested_at);
