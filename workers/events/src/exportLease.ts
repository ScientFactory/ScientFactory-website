/** Serialize PostHog exports and erasures across Worker invocations, not just one isolate. */
export async function withExportLease(
  database: D1Database,
  operation: (beforeRequest: () => Promise<void>) => Promise<number>,
): Promise<number> {
  const owner = crypto.randomUUID();
  const now = Date.now();
  const claim = await database
    .prepare(
      `INSERT INTO analytics_maintenance_leases (name, owner, expires_at)
     VALUES ('posthog', ?, ?)
     ON CONFLICT(name) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
     WHERE analytics_maintenance_leases.expires_at < ?`,
    )
    .bind(owner, now + 60_000, now)
    .run();
  if (claim.meta.changes !== 1) return 0;
  try {
    return await operation(async () => {
      // D1 work can outlive the original lease. Renew using the database clock
      // immediately before every external request, but never revive a stale owner.
      const renewed = await database
        .prepare(`UPDATE analytics_maintenance_leases
        SET expires_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) + 60000
        WHERE name = 'posthog' AND owner = ?
          AND expires_at > CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
        RETURNING expires_at`)
        .bind(owner)
        .first<{ expires_at: number }>();
      if (!renewed || renewed.expires_at - Date.now() < 10_000) {
        throw new Error("export-lease-lost");
      }
    });
  } finally {
    await database
      .prepare("DELETE FROM analytics_maintenance_leases WHERE name = 'posthog' AND owner = ?")
      .bind(owner)
      .run();
  }
}
