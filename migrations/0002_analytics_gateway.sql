CREATE TABLE analytics_events (
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
  posthog_state TEXT NOT NULL DEFAULT 'pending' CHECK (posthog_state IN ('pending', 'sent')),
  posthog_attempts INTEGER NOT NULL DEFAULT 0,
  posthog_last_error TEXT,
  posthog_sent_at TEXT
);

CREATE INDEX analytics_events_name_occurred_at
  ON analytics_events (event_name, occurred_at);

CREATE INDEX analytics_events_source_occurred_at
  ON analytics_events (source, occurred_at);

CREATE INDEX analytics_events_posthog_queue
  ON analytics_events (posthog_state, received_at);
