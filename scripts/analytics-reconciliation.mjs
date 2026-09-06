/** Same source, occurrence window and event-ID grain on both sides of the gateway. */
export function reconciliationQueries({ source = "desktop", from, to }) {
  if (!["desktop", "website"].includes(source)) throw new Error("Invalid source");
  const start = new Date(from);
  const end = new Date(to);
  if (
    !Number.isFinite(+start) ||
    !Number.isFinite(+end) ||
    +end <= +start ||
    +end - +start > 30 * 86400000
  ) {
    throw new Error("Use an increasing window no longer than 30 days");
  }
  const since = start.toISOString();
  const until = end.toISOString();
  return {
    source,
    from: since,
    to: until,
    d1: `SELECT event_name, posthog_state, COUNT(*) AS event_count
      FROM analytics_events WHERE source = '${source}'
        AND (source <> 'desktop' OR privacy_level <> 'diagnostic')
        AND julianday(occurred_at) >= julianday('${since}') AND julianday(occurred_at) < julianday('${until}')
      GROUP BY event_name, posthog_state ORDER BY event_name, posthog_state`,
    posthog: `SELECT event, uniqExact(properties.event_id) FROM events
      WHERE properties.source = '${source}' AND properties.event_id IS NOT NULL
        AND (properties.source != 'desktop' OR coalesce(properties.privacy_level, '') != 'diagnostic')
        AND timestamp >= parseDateTimeBestEffort('${since}') AND timestamp < parseDateTimeBestEffort('${until}')
      GROUP BY event ORDER BY event`,
    backlog: `SELECT posthog_state, count(*) AS request_count FROM analytics_deletion_requests
      WHERE posthog_state <> 'completed' GROUP BY posthog_state`,
  };
}

export function comparePipeline(d1Rows, posthogRows, deletionBacklog = 0) {
  const counts = new Map();
  const rowFor = (name) => {
    if (!counts.has(name)) counts.set(name, { name, sent: 0, pending: 0, posthog: 0 });
    return counts.get(name);
  };
  const count = (value) => {
    const result = Number(value);
    if (!Number.isSafeInteger(result) || result < 0)
      throw new Error("Invalid reconciliation count");
    return result;
  };
  for (const row of d1Rows) {
    if (!["sent", "pending"].includes(row.posthog_state)) throw new Error("Unknown delivery state");
    rowFor(String(row.event_name))[row.posthog_state] += count(row.event_count);
  }
  for (const [name, value] of posthogRows) rowFor(String(name)).posthog += count(value);
  const rows = [...counts.values()].sort((a, b) => a.name.localeCompare(b.name));
  const status =
    count(deletionBacklog) > 0 || rows.some((row) => row.pending > 0)
      ? "unsettled"
      : rows.length === 0
        ? "no-data"
        : rows.some((row) => row.sent !== row.posthog)
          ? "mismatch"
          : "matched";
  return { status, rows, deletionBacklog };
}
