-- Rows the PostHog export never sends (desktop diagnostics and identity
-- observations) used to stay 'pending' forever, so every export re-read them.
-- They now get 'excluded'. SQLite cannot widen a CHECK constraint in place, so
-- rebuild the table. Triggers are recreated after the copy so it does not
-- recount daily totals.
CREATE TABLE analytics_events_rebuilt (
  event_id TEXT PRIMARY KEY,
  event_name TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('website', 'desktop')),
  privacy_level TEXT NOT NULL CHECK (
    privacy_level IN ('essential', 'product', 'diagnostic', 'contribution')
  ),
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  distinct_id TEXT NOT NULL,
  properties_json TEXT NOT NULL,
  posthog_state TEXT NOT NULL DEFAULT 'pending' CHECK (
    posthog_state IN ('pending', 'sent', 'excluded')
  ),
  posthog_attempts INTEGER NOT NULL DEFAULT 0,
  posthog_last_error TEXT,
  posthog_sent_at TEXT,
  identity_type TEXT NOT NULL DEFAULT 'event',
  canonical_id TEXT NOT NULL DEFAULT '',
  session_id TEXT,
  consent_level TEXT NOT NULL DEFAULT 'essential',
  posthog_next_attempt_at TEXT
);

INSERT INTO analytics_events_rebuilt (
  event_id, event_name, source, privacy_level, occurred_at, received_at, distinct_id,
  properties_json, posthog_state, posthog_attempts, posthog_last_error, posthog_sent_at,
  identity_type, canonical_id, session_id, consent_level, posthog_next_attempt_at
)
SELECT
  event_id, event_name, source, privacy_level, occurred_at, received_at, distinct_id,
  properties_json,
  CASE WHEN posthog_state = 'pending' AND (
      (source = 'desktop' AND privacy_level = 'diagnostic')
      OR event_name IN ('install.account_observed', 'install.profile_observed')
      OR (event_name = 'install.owner_observed' AND json_valid(properties_json)
        AND json_extract(properties_json, '$.ownerSource') = 'device')
    ) THEN 'excluded' ELSE posthog_state END,
  posthog_attempts, posthog_last_error, posthog_sent_at,
  identity_type, canonical_id, session_id, consent_level, posthog_next_attempt_at
FROM analytics_events;

DROP TABLE analytics_events;
ALTER TABLE analytics_events_rebuilt RENAME TO analytics_events;

CREATE INDEX analytics_events_name_occurred_at ON analytics_events (event_name, occurred_at);
CREATE INDEX analytics_events_source_occurred_at ON analytics_events (source, occurred_at);
CREATE INDEX analytics_events_posthog_queue ON analytics_events (posthog_state, received_at);
CREATE INDEX analytics_events_canonical_occurred_at ON analytics_events (canonical_id, occurred_at);
CREATE INDEX analytics_events_session_occurred_at ON analytics_events (session_id, occurred_at);
CREATE INDEX analytics_events_retention ON analytics_events (received_at, event_id);

CREATE TRIGGER analytics_no_deleted_event
BEFORE INSERT ON analytics_events
WHEN EXISTS (SELECT 1 FROM analytics_deleted_installations WHERE installation_id = NEW.distinct_id)
BEGIN
  SELECT RAISE(ABORT, 'deleted-installation');
END;

CREATE TRIGGER analytics_daily_event_totals AFTER INSERT ON analytics_events
WHEN NEW.event_name NOT IN ('install.account_observed', 'install.profile_observed')
BEGIN
  INSERT INTO analytics_daily_totals (day, metric, dimension, value, computed_at)
  VALUES (substr(NEW.occurred_at, 1, 10), 'events', NEW.event_name, 1, CURRENT_TIMESTAMP)
  ON CONFLICT(day, metric, dimension) DO UPDATE SET value = value + 1, computed_at = excluded.computed_at;
END;

CREATE TRIGGER analytics_daily_active_totals AFTER INSERT ON analytics_events
WHEN NEW.source = 'desktop' AND NEW.event_name NOT IN ('install.account_observed', 'install.profile_observed')
BEGIN
  INSERT OR IGNORE INTO analytics_daily_members (day, installation_id)
  VALUES (substr(NEW.occurred_at, 1, 10), NEW.distinct_id);
  INSERT INTO analytics_daily_totals (day, metric, dimension, value, computed_at)
  SELECT substr(NEW.occurred_at, 1, 10), 'active_installations', '', 1, CURRENT_TIMESTAMP WHERE changes() = 1
  ON CONFLICT(day, metric, dimension) DO UPDATE SET value = value + 1, computed_at = excluded.computed_at;
END;
