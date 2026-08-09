ALTER TABLE analytics_deletion_requests
  ADD COLUMN posthog_distinct_id TEXT;

UPDATE analytics_deletion_requests
  SET posthog_distinct_id = installation_id
  WHERE posthog_distinct_id IS NULL;
