/// <reference types="node" />
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

/** Exercises real migration/transaction SQL; not a substitute for D1 deployment proof. */
export function testDatabase(beforeReadiness?: (sqlite: DatabaseSync) => void) {
  const sqlite = new DatabaseSync(":memory:");
  const migrations = new URL("../../../migrations/", import.meta.url);
  for (const file of readdirSync(migrations)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    if (file === "0006_analytics_readiness.sql") beforeReadiness?.(sqlite);
    sqlite.exec(readFileSync(new URL(file, migrations), "utf8"));
  }
  const prepare = (sql: string, bindings: SQLInputValue[] = []) => {
    const result = () => {
      const before = Number(sqlite.prepare("SELECT total_changes() AS n").get()!.n);
      const results = sqlite.prepare(sql).all(...bindings);
      const changes = Number(sqlite.prepare("SELECT total_changes() AS n").get()!.n) - before;
      return { success: true, results, meta: { changes } };
    };
    return {
      bind: (...values: SQLInputValue[]) => prepare(sql, values),
      first: async (column?: string) => {
        const row = sqlite.prepare(sql).get(...bindings);
        return row ? (column ? row[column] : row) : null;
      },
      all: async () => result(),
      run: async () => result(),
      execute: result,
    };
  };
  const adapter = {
    prepare,
    batch: async (statements: ReturnType<typeof prepare>[]) => {
      sqlite.exec("BEGIN");
      try {
        const results = statements.map((statement) => statement.execute());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
  // This test adapter implements only the D1 methods used by the gateway.
  return { database: adapter as unknown as D1Database, sqlite, close: () => sqlite.close() };
}
