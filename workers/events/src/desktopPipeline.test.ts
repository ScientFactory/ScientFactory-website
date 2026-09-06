/// <reference types="node" />
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import worker, { flushPendingEvents } from "./index";
import { testDatabase } from "./sqlite.testSupport";

// Opt-in cross-repository qualification, not an implicit sibling-checkout dependency.
// Build the exact desktop candidate first; all traffic below stays on loopback/mock.
const desktopRoot = process.env.SCIENT_ANALYTICS_DESKTOP_ROOT;
it.skipIf(!desktopRoot)(
  "qualifies the built desktop worker through the gateway and real ledger",
  async () => {
    const root = resolve(desktopRoot!);
    const { createAnalyticsRuntime } = await import(
      /* @vite-ignore */ pathToFileURL(join(root, "packages/scient-analytics/src/runtime.ts")).href
    );
    const fixture = mkdtempSync(join(tmpdir(), "scient-pipeline-proof-"));
    const store = testDatabase();
    const tasks: Promise<unknown>[] = [];
    const uploads: { token: string; body: string }[] = [];
    const env = {
      ANALYTICS_DB: store.database,
      DESKTOP_INGESTION_ENABLED: "true",
      ANALYTICS_INGESTION_RATE_LIMITER: { limit: async () => ({ success: true }) },
    };
    const context = {
      waitUntil: (task: Promise<unknown>) => tasks.push(task),
    } as unknown as ExecutionContext;
    const server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks).toString("utf8");
        const token = String(request.headers["x-scient-installation-token"] ?? "");
        if (request.url === "/v1/events") uploads.push({ token, body });
        const result = await worker.fetch!(
          new Request(`http://127.0.0.1${request.url}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Scient-Installation-Token": token },
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
    const endpoint = `http://127.0.0.1:${address.port}/v1/events`;
    const runtime = createAnalyticsRuntime({
      enabled: true,
      consent: "product",
      outboxPath: join(fixture, "outbox.sqlite"),
      endpoint,
      workerUrl: pathToFileURL(join(root, "apps/server/dist/analytics-worker.mjs")),
      appVersion: "0.6.8",
      buildChannel: "development",
    });
    const originalFetch = globalThis.fetch;
    try {
      runtime.record("provider.turn.sent", {
        provider: "codex",
        model: "PRIVATE-MODEL",
        prompt: "PRIVATE-CONTENT",
      });
      runtime.record("scient.operation.completed", {
        operationKind: "pdf-export",
        durationMs: 1234,
      });
      runtime.record("provider.lifecycle.completed", {
        provider: "codex",
        action: "install",
        source: "scient_managed",
      });
      runtime.record("scient.operation.skipped", {
        operationKind: "source-import",
        trigger: "user",
        title: "PRIVATE-SOURCE",
      });
      expect(await runtime.flush()).toBe(4);
      expect(await runtime.pendingCount()).toBe(0);
      expect(store.sqlite.prepare("SELECT count(*) AS n FROM analytics_events").get()!.n).toBe(4);
      expect(uploads[0]!.body).not.toContain("PRIVATE");
      const exportRequest = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
      vi.stubGlobal("fetch", exportRequest);
      expect(
        await flushPendingEvents({
          ...env,
          DESKTOP_POSTHOG_EXPORT_ENABLED: "true",
          POSTHOG_PROJECT_TOKEN: "synthetic",
        }),
      ).toBe(4);
      expect(exportRequest).toHaveBeenCalledOnce();
      expect(String(exportRequest.mock.calls[0]![1].body)).not.toContain("PRIVATE");
      const exported = JSON.parse(String(exportRequest.mock.calls[0]![1].body));
      expect(
        exported.batch.find(
          (event: { event: string }) => event.event === "provider.lifecycle.completed",
        ).properties,
      ).toMatchObject({ source: "desktop", runtimeSource: "scient_managed" });
      expect(
        exported.batch.find(
          (event: { event: string }) => event.event === "scient.operation.skipped",
        ).properties,
      ).toMatchObject({ operationKind: "source-import", trigger: "user" });
      await runtime.setConsent("off");
      expect(runtime.record("project.opened")).toBe(false);
      expect(await runtime.flush()).toBe(0);
      expect(await runtime.deleteData()).toBe(true);
      expect(store.sqlite.prepare("SELECT count(*) AS n FROM analytics_events").get()!.n).toBe(0);
      expect(
        store.sqlite.prepare("SELECT posthog_state FROM analytics_deletion_requests").get()!
          .posthog_state,
      ).toBe("pending");
      // An acknowledged deletion must resist delayed uploads with the old credential.
      const replay = await originalFetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Scient-Installation-Token": uploads[0]!.token,
        },
        body: uploads[0]!.body,
      });
      expect(replay.status).toBe(403);
      await replay.body?.cancel();
    } finally {
      await runtime.close();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      await Promise.allSettled(tasks);
      store.close();
      rmSync(fixture, { recursive: true, force: true });
      vi.unstubAllGlobals();
    }
  },
  15_000,
);
