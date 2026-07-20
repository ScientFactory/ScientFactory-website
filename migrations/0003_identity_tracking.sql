CREATE TABLE analytics_identities (
  identity_id TEXT PRIMARY KEY,
  identity_type TEXT NOT NULL CHECK (
    identity_type IN ('web_visitor', 'desktop_installation', 'account')
  ),
  canonical_id TEXT NOT NULL,
  consent_level TEXT NOT NULL CHECK (
    consent_level IN ('essential', 'product', 'diagnostic', 'contribution')
  ),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  linked_at TEXT
);

CREATE INDEX analytics_identities_canonical_id
  ON analytics_identities (canonical_id);

CREATE TABLE analytics_identity_links (
  link_id TEXT PRIMARY KEY,
  source_identity_id TEXT NOT NULL UNIQUE,
  canonical_id TEXT NOT NULL,
  linked_at TEXT NOT NULL,
  posthog_state TEXT NOT NULL DEFAULT 'pending' CHECK (posthog_state IN ('pending', 'sent')),
  posthog_attempts INTEGER NOT NULL DEFAULT 0,
  posthog_last_error TEXT,
  posthog_sent_at TEXT,
  FOREIGN KEY (source_identity_id) REFERENCES analytics_identities(identity_id),
  FOREIGN KEY (canonical_id) REFERENCES analytics_identities(identity_id)
);

CREATE INDEX analytics_identity_links_posthog_queue
  ON analytics_identity_links (posthog_state, linked_at);

CREATE TABLE analytics_consents (
  consent_id TEXT PRIMARY KEY,
  identity_id TEXT,
  source TEXT NOT NULL CHECK (source IN ('website', 'desktop')),
  consent_level TEXT NOT NULL CHECK (
    consent_level IN ('essential', 'product', 'diagnostic', 'contribution')
  ),
  notice_version TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  FOREIGN KEY (identity_id) REFERENCES analytics_identities(identity_id)
);

CREATE INDEX analytics_consents_identity_recorded_at
  ON analytics_consents (identity_id, recorded_at);

CREATE TRIGGER analytics_desktop_identity_consent_created
AFTER INSERT ON analytics_identities
WHEN NEW.identity_type = 'desktop_installation'
BEGIN
  INSERT INTO analytics_consents (
    consent_id, identity_id, source, consent_level, notice_version, recorded_at
  ) VALUES (
    lower(hex(randomblob(16))),
    NEW.identity_id,
    'desktop',
    NEW.consent_level,
    '2026-07-identity-v1',
    NEW.first_seen_at
  );
END;

CREATE TRIGGER analytics_desktop_identity_consent_changed
AFTER UPDATE OF consent_level ON analytics_identities
WHEN NEW.identity_type = 'desktop_installation' AND OLD.consent_level <> NEW.consent_level
BEGIN
  INSERT INTO analytics_consents (
    consent_id, identity_id, source, consent_level, notice_version, recorded_at
  ) VALUES (
    lower(hex(randomblob(16))),
    NEW.identity_id,
    'desktop',
    NEW.consent_level,
    '2026-07-identity-v1',
    NEW.last_seen_at
  );
END;

ALTER TABLE analytics_events
  ADD COLUMN identity_type TEXT NOT NULL DEFAULT 'event';

ALTER TABLE analytics_events
  ADD COLUMN canonical_id TEXT NOT NULL DEFAULT '';

ALTER TABLE analytics_events
  ADD COLUMN session_id TEXT;

ALTER TABLE analytics_events
  ADD COLUMN consent_level TEXT NOT NULL DEFAULT 'essential';

UPDATE analytics_events
SET
  canonical_id = distinct_id,
  identity_type = CASE
    WHEN distinct_id LIKE 'installation:%' THEN 'desktop_installation'
    ELSE 'event'
  END,
  consent_level = CASE
    WHEN source = 'desktop' THEN privacy_level
    ELSE 'essential'
  END;

CREATE INDEX analytics_events_canonical_occurred_at
  ON analytics_events (canonical_id, occurred_at);

CREATE INDEX analytics_events_session_occurred_at
  ON analytics_events (session_id, occurred_at);
