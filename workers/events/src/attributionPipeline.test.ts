/// <reference types="node" />
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import worker from "./index";
import { testDatabase } from "./sqlite.testSupport";

/**
 * The questions the failure-attribution data exists to answer, run on the real ledger schema.
 * Insights reads the same columns; these are the reference definitions.
 */
export const ATTRIBUTION_QUERIES = {
  /** Per Scient capability: finished attempts, failures by owner, and Scient's own failures. */
  operationOutcomes: `
    SELECT
      json_extract(properties_json, '$.operationKind') AS operation_kind,
      count(*) AS finished,
      sum(event_name = 'scient.operation.failed') AS failed,
      sum(json_extract(properties_json, '$.failureOwner') = 'scient') AS failed_scient,
      sum(json_extract(properties_json, '$.failureOwner') = 'code') AS failed_code,
      sum(json_extract(properties_json, '$.failureOwner') = 'environment') AS failed_environment,
      sum(json_extract(properties_json, '$.failureOwner') = 'external') AS failed_external,
      sum(json_extract(properties_json, '$.failureOwner') = 'unknown') AS failed_unknown
    FROM analytics_events
    WHERE event_name IN ('scient.operation.completed', 'scient.operation.failed')
    GROUP BY operation_kind
    ORDER BY operation_kind`,
  /** Scient tool calls agents made that failed, by owner. */
  toolFailures: `
    SELECT
      json_extract(properties_json, '$.tool') AS tool,
      json_extract(properties_json, '$.failureOwner') AS failure_owner,
      count(*) AS calls
    FROM analytics_events
    WHERE event_name = 'mcp.tool.invoked' AND json_extract(properties_json, '$.outcome') = 'error'
    GROUP BY tool, failure_owner
    ORDER BY tool, failure_owner`,
  /** What agents ran in their own terminal instead of, or beyond, Scient's tools. */
  commandsOutsideScient: `
    SELECT
      json_extract(properties_json, '$.commandCategory') AS category,
      sum(json_extract(properties_json, '$.commandCount')) AS commands,
      sum(json_extract(properties_json, '$.failedCount')) AS failed,
      count(DISTINCT distinct_id) AS installations
    FROM analytics_events
    WHERE event_name = 'provider.commands.observed'
    GROUP BY category
    ORDER BY commands DESC, category`,
} as const;

// Opt-in cross-repository qualification: build the exact desktop candidate first.
const desktopRoot = process.env.SCIENT_ANALYTICS_DESKTOP_ROOT;
it.skipIf(!desktopRoot)(
  "carries failure owners and agent command categories from the desktop producers to the ledger",
  async () => {
    const root = resolve(desktopRoot!);
    const load = (path: string) => import(/* @vite-ignore */ pathToFileURL(join(root, path)).href);
    const { createAnalyticsRuntime } = await load("packages/scient-analytics/src/runtime.ts");
    const attribution = await load("apps/server/src/telemetry/FailureAttribution.ts");
    const { classifyCommand } = await load("apps/server/src/telemetry/CommandCategories.ts");
    const fixture = mkdtempSync(join(tmpdir(), "scient-attribution-proof-"));
    const store = testDatabase();
    const env = {
      ANALYTICS_DB: store.database,
      DESKTOP_INGESTION_ENABLED: "true",
      ANALYTICS_INGESTION_RATE_LIMITER: { limit: async () => ({ success: true }) },
    };
    const context = { waitUntil: () => undefined } as unknown as ExecutionContext;
    const uploads: string[] = [];
    const server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks).toString("utf8");
        uploads.push(body);
        const result = await worker.fetch!(
          new Request(`http://127.0.0.1${request.url}`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Scient-Installation-Token": String(
                request.headers["x-scient-installation-token"] ?? "",
              ),
            },
            body,
          }) as Request<unknown, IncomingRequestCfProperties>,
          env,
          context,
        );
        response.writeHead(result.status, { "Content-Type": "application/json" });
        response.end(await result.text());
      })().catch(() => {
        response.writeHead(500);
        response.end();
      });
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No fixture port");
    const runtime = createAnalyticsRuntime({
      enabled: true,
      consent: "product",
      outboxPath: join(fixture, "outbox.sqlite"),
      endpoint: `http://127.0.0.1:${address.port}/v1/events`,
      workerUrl: pathToFileURL(join(root, "apps/server/dist/analytics-worker.mjs")),
      appVersion: "0.6.8",
      buildChannel: "development",
    });
    try {
      const run = (status: "completed" | "failed", extra: Record<string, unknown> = {}) =>
        runtime.record(`scient.operation.${status}`, {
          operationKind: "compute-run",
          trigger: "other",
          durationMs: 900,
          language: "python",
          actor: "agent",
          entry: "console",
          runtimeSource: "managed",
          ...extra,
        });
      run("completed");
      run("completed");
      // The user's code raised: counted, but not as Scient's failure.
      run("failed", {
        ...attribution.computeRunAttribution(
          { kind: "runtime-reported", errorName: "ZeroDivisionError" },
          true,
        ),
      });
      run("failed", attribution.computeRunAttribution({ kind: "not-admitted" }, true));
      run(
        "failed",
        attribution.computeRunAttribution(
          { kind: "runtime-reported", errorName: "ModuleNotFoundError" },
          false,
        ),
      );
      runtime.record("scient.operation.failed", {
        operationKind: "latex-build",
        trigger: "other",
        failureClass: "missing_package",
        ...attribution.latexBuildAttribution("missing_package"),
      });
      runtime.record("scient.operation.failed", {
        operationKind: "compute-artifact",
        trigger: "other",
        captureSchemaVersion: 2,
        captureSource: "interactive",
        captureOutcome: "failed",
        captureReason: "persistence-failed",
        ...attribution.captureRejectionAttribution("persistence-failed"),
      });
      runtime.record("mcp.tool.invoked", {
        tool: "preview_act",
        callerProvider: "codex",
        outcome: "error",
        errorCode: "invalid_selector",
        failureOwner: attribution.toolFailureAttribution("invalid_selector").failureOwner,
      });
      runtime.record("mcp.tool.invoked", {
        tool: "preview_act",
        callerProvider: "codex",
        outcome: "error",
        errorCode: "no_host",
        failureOwner: attribution.toolFailureAttribution("no_host").failureOwner,
      });
      // Agent terminal commands, as the turn observer tallies them: category only.
      const commands = [
        '/bin/zsh -lc "python /Users/someone/PRIVATE-STUDY/fit.py"',
        "python3 -m pip install PRIVATE-PACKAGE",
        "stata-mp -b do PRIVATE.do",
        "stata-mp -b do PRIVATE-2.do",
      ];
      const tallies = new Map<string, number>();
      for (const command of commands)
        for (const category of classifyCommand(command))
          tallies.set(category, (tallies.get(category) ?? 0) + 1);
      for (const [commandCategory, commandCount] of tallies)
        runtime.record("provider.commands.observed", {
          provider: "codex",
          model: "gpt-6.1-sol",
          commandCategory,
          commandCount,
          failedCount: commandCategory === "stata" ? 1 : 0,
        });
      runtime.record("provider.commands.observed", {
        provider: "codex",
        model: "gpt-6.1-sol",
        commandCategory: "python /Users/someone/PRIVATE-STUDY/fit.py",
        commandCount: 1,
        failedCount: 0,
      });

      expect(await runtime.flush()).toBe(13);
      expect(store.sqlite.prepare("SELECT count(*) AS n FROM analytics_events").get()!.n).toBe(13);
      expect(uploads.join("\n")).not.toMatch(/PRIVATE|someone|ZeroDivisionError/u);

      const rows = (sql: string) =>
        store.sqlite
          .prepare(sql)
          .all()
          .map((row) => ({ ...row }));
      expect(rows(ATTRIBUTION_QUERIES.operationOutcomes)).toEqual([
        {
          operation_kind: "compute-artifact",
          finished: 1,
          failed: 1,
          failed_scient: 1,
          failed_code: 0,
          failed_environment: 0,
          failed_external: 0,
          failed_unknown: 0,
        },
        {
          operation_kind: "compute-run",
          finished: 5,
          failed: 3,
          failed_scient: 1,
          failed_code: 1,
          failed_environment: 1,
          failed_external: 0,
          failed_unknown: 0,
        },
        {
          operation_kind: "latex-build",
          finished: 1,
          failed: 1,
          failed_scient: 0,
          failed_code: 0,
          failed_environment: 1,
          failed_external: 0,
          failed_unknown: 0,
        },
      ]);
      expect(rows(ATTRIBUTION_QUERIES.toolFailures)).toEqual([
        { tool: "preview_act", failure_owner: "input", calls: 1 },
        { tool: "preview_act", failure_owner: "scient", calls: 1 },
      ]);
      expect(rows(ATTRIBUTION_QUERIES.commandsOutsideScient)).toEqual([
        { category: "stata", commands: 2, failed: 1, installations: 1 },
        { category: "python", commands: 1, failed: 0, installations: 1 },
        { category: "python-package-install", commands: 1, failed: 0, installations: 1 },
        // Free text never becomes a category.
        { category: "unknown", commands: 1, failed: 0, installations: 1 },
      ]);
      const failedRun = JSON.parse(
        String(
          store.sqlite
            .prepare(
              "SELECT properties_json FROM analytics_events WHERE event_name = 'scient.operation.failed' AND json_extract(properties_json, '$.failureOwner') = 'code'",
            )
            .get()!.properties_json,
        ),
      );
      expect(failedRun).toMatchObject({
        operationKind: "compute-run",
        failureOwner: "code",
        failureCategory: "code-error",
        language: "python",
        actor: "agent",
        entry: "console",
        runtimeSource: "managed",
        contractRevision: "11",
      });
    } finally {
      await runtime.close();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      store.close();
      rmSync(fixture, { recursive: true, force: true });
    }
  },
);
