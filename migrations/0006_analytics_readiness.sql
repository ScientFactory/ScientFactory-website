-- A minimal authenticated tombstone prevents late uploads recreating deleted data.
-- It deliberately has no FK to the identity record, which is erased.
CREATE TABLE analytics_deleted_installations (
  installation_id TEXT PRIMARY KEY,
  deletion_token_hash TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  requested_at TEXT NOT NULL
);

-- Earlier releases erased authentication history. Keep those IDs blocked rather
-- than treating a subsequent upload as a new installation. The sentinel cannot
-- match any SHA-256 token; these legacy receipts need operator reconciliation.
INSERT INTO analytics_deleted_installations
  (installation_id, deletion_token_hash, request_id, requested_at)
SELECT installation_id, 'legacy-authentication-unavailable', request_id, requested_at
FROM (
  SELECT *, row_number() OVER (PARTITION BY installation_id ORDER BY requested_at, request_id) AS ordinal
  FROM analytics_deletion_requests
) WHERE ordinal = 1;

CREATE TRIGGER analytics_no_deleted_identity
BEFORE INSERT ON analytics_identities
WHEN EXISTS (SELECT 1 FROM analytics_deleted_installations WHERE installation_id = NEW.identity_id)
BEGIN
  SELECT RAISE(ABORT, 'deleted-installation');
END;

CREATE TRIGGER analytics_no_deleted_event
BEFORE INSERT ON analytics_events
WHEN EXISTS (SELECT 1 FROM analytics_deleted_installations WHERE installation_id = NEW.distinct_id)
BEGIN
  SELECT RAISE(ABORT, 'deleted-installation');
END;

ALTER TABLE analytics_identities ADD COLUMN posthog_attempted INTEGER NOT NULL DEFAULT 0;
-- Existing identities have unknown export history, possibly older than retention.
UPDATE analytics_identities SET posthog_attempted = 1 WHERE identity_type = 'desktop_installation';

ALTER TABLE analytics_deletion_requests ADD COLUMN posthog_person_uuid TEXT;
ALTER TABLE analytics_deletion_requests ADD COLUMN posthog_submitted_at TEXT;
-- Provider verification has a cutoff; it is not proof all captures have settled.
ALTER TABLE analytics_deletion_requests ADD COLUMN posthog_verified_at TEXT;
ALTER TABLE analytics_deletion_requests ADD COLUMN next_attempt_at TEXT;
-- Old acknowledgements proved submission, not verified event erasure.
UPDATE analytics_deletion_requests
SET posthog_state = 'blocked', posthog_last_error_class = 'legacy-unverified-deletion', completed_at = NULL
WHERE posthog_state IN ('completed', 'pending');

-- Only post-migration installations have complete observation history. Never
-- manufacture an activation cohort from a rolling window of old events.
ALTER TABLE analytics_identities ADD COLUMN product_first_seen_at TEXT;
ALTER TABLE analytics_identities ADD COLUMN cohort_eligible INTEGER NOT NULL DEFAULT 1;
UPDATE analytics_identities SET cohort_eligible = 0;

CREATE TABLE analytics_maintenance_leases (
  name TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE analytics_maintenance_status (
  name TEXT PRIMARY KEY,
  completed_at TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'failed'))
);

CREATE INDEX analytics_events_retention ON analytics_events (received_at, event_id);
ALTER TABLE analytics_events ADD COLUMN posthog_next_attempt_at TEXT;
ALTER TABLE analytics_identity_links ADD COLUMN posthog_next_attempt_at TEXT;
