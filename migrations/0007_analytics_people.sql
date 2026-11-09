-- Who uses Scient and from where. These tables are never exported to PostHog.
-- Rows are written only while IDENTITY_ANALYTICS_ENABLED is "true".

-- The network each desktop installation uploads from, one row per address per day.
CREATE TABLE analytics_installation_sightings (
  installation_id TEXT NOT NULL,
  day TEXT NOT NULL,
  ip_address TEXT NOT NULL,
  country TEXT,
  region TEXT,
  city TEXT,
  timezone TEXT,
  asn INTEGER,
  network_name TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, day, ip_address)
);
CREATE INDEX analytics_installation_sightings_ip
  ON analytics_installation_sightings (ip_address, day);

-- Accounts an installation is signed in to: agent sign-ins and Scient Agent's subscriptions.
CREATE TABLE analytics_installation_accounts (
  installation_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  plan TEXT NOT NULL DEFAULT '',
  account_type TEXT NOT NULL DEFAULT '',
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, provider, email, plan, account_type)
);
CREATE INDEX analytics_installation_accounts_email
  ON analytics_installation_accounts (email);

-- The latest answers to "How will you use Scient?".
CREATE TABLE analytics_installation_profiles (
  installation_id TEXT PRIMARY KEY,
  work_kinds TEXT,
  field TEXT,
  role TEXT,
  other_work TEXT,
  answered_at TEXT NOT NULL
);

-- The network of each website event, to match a download with the installation it became.
CREATE TABLE analytics_web_sightings (
  event_id TEXT PRIMARY KEY,
  event_name TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  visitor_id TEXT NOT NULL,
  ip_address TEXT NOT NULL,
  referrer_host TEXT,
  country TEXT,
  region TEXT,
  city TEXT,
  timezone TEXT,
  asn INTEGER,
  network_name TEXT
);
CREATE INDEX analytics_web_sightings_ip ON analytics_web_sightings (ip_address, occurred_at);

-- A download followed by a new installation's first upload from the same address within a day.
CREATE VIEW analytics_download_installation_candidates AS
SELECT
  'shared_ip_within_24h' AS evidence,
  web.event_id AS download_event_id,
  web.occurred_at AS downloaded_at,
  web.visitor_id,
  web.referrer_host,
  web.country,
  web.city,
  web.network_name,
  identities.identity_id AS installation_id,
  identities.first_seen_at AS installation_first_seen_at
FROM analytics_web_sightings AS web
JOIN analytics_installation_sightings AS sightings ON sightings.ip_address = web.ip_address
JOIN analytics_identities AS identities
  ON identities.identity_id = sightings.installation_id
  AND identities.identity_type = 'desktop_installation'
WHERE web.event_name = 'download_clicked'
  AND julianday(identities.first_seen_at) >= julianday(web.occurred_at)
  AND julianday(identities.first_seen_at) <= julianday(web.occurred_at, '+1 day')
  AND sightings.day = substr(identities.first_seen_at, 1, 10);

-- Daily counts with nothing personal in them, kept permanently.
CREATE TABLE analytics_daily_totals (
  day TEXT NOT NULL,
  metric TEXT NOT NULL,
  dimension TEXT NOT NULL DEFAULT '',
  value INTEGER NOT NULL,
  computed_at TEXT NOT NULL,
  PRIMARY KEY (day, metric, dimension)
);

CREATE TABLE analytics_rollup_state (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS analytics_identities_type_last_seen
  ON analytics_identities (identity_type, last_seen_at);

-- These hashes identify devices, never a guaranteed individual person.
CREATE TABLE analytics_installation_devices (
  installation_id TEXT NOT NULL,
  device_hash TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, device_hash)
);
CREATE INDEX analytics_devices_hash ON analytics_installation_devices(device_hash);

CREATE VIEW analytics_account_installations AS
SELECT email, installation_id, provider, account_type, plan, first_seen_at, last_seen_at
FROM analytics_installation_accounts WHERE email <> '';

CREATE TABLE analytics_expired_identities (identity_id TEXT PRIMARY KEY);
CREATE TABLE analytics_daily_members (
  day TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  PRIMARY KEY (day, installation_id)
);

INSERT INTO analytics_daily_totals (day, metric, dimension, value, computed_at)
SELECT substr(occurred_at, 1, 10), 'events', event_name, count(*), CURRENT_TIMESTAMP
FROM analytics_events
WHERE event_name NOT IN ('install.account_observed', 'install.profile_observed')
GROUP BY substr(occurred_at, 1, 10), event_name;

INSERT OR IGNORE INTO analytics_daily_members (day, installation_id)
SELECT substr(occurred_at, 1, 10), distinct_id FROM analytics_events
WHERE source = 'desktop' AND event_name NOT IN ('install.account_observed', 'install.profile_observed');
INSERT INTO analytics_daily_totals (day, metric, dimension, value, computed_at)
SELECT day, 'active_installations', '', count(*), CURRENT_TIMESTAMP
FROM analytics_daily_members GROUP BY day;

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
CREATE TRIGGER analytics_daily_country_totals AFTER INSERT ON analytics_installation_sightings
WHEN NEW.country IS NOT NULL
BEGIN
  INSERT INTO analytics_daily_totals (day, metric, dimension, value, computed_at)
  VALUES (NEW.day, 'network_observations', NEW.country, 1, CURRENT_TIMESTAMP)
  ON CONFLICT(day, metric, dimension) DO UPDATE SET value = value + 1, computed_at = excluded.computed_at;
END;
