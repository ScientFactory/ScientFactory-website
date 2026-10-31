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
      for (const provider of ["scient", "omp", "muse", "acpRegistry"]) {
        runtime.record("provider.turn.sent", { provider, prompt: "PRIVATE-CONTENT" });
        runtime.record("provider.installation.observed", { provider, installed: true });
      }
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
      runtime.record("provider.turn.usage", {
        provider: "codex",
        model: "PRIVATE-MODEL",
        terminalStatus: "completed",
        usageStatus: "complete",
        inputTokens: 12345,
        outputTokens: 678,
        cachedInputTokens: 200,
        createdBy: "user",
        creationSource: "web",
        scheduled: false,
        subagent: false,
      });
      runtime.record("feature.viewed", { feature: "latex-visual", path: "PRIVATE-DOCUMENT" });
      const ownerId = "a".repeat(64);
      runtime.record("server.boot.heartbeat", { threadCount: 84, projectCount: 6 });
      runtime.record("install.owner_observed", {
        ownerSource: "openai",
        ownerId,
        observedBy: "server",
      });
      runtime.record("install.owner_observed", {
        ownerSource: "openai",
        ownerId: "user-PRIVATE-ACCOUNT",
        observedBy: "server",
      });
      runtime.record("client.turn.requested", {
        surface: "desktop",
        clientOs: "macOS",
        clientBrowser: "PRIVATE-BROWSER",
      });
      runtime.record("feature.used", {
        feature: "checkpoint.rollback",
        variant: "with_files",
        surface: "desktop",
      });
      runtime.record("mcp.tool.invoked", {
        tool: "delegate_task",
        callerProvider: "codex",
        outcome: "ok",
        durationMs: 40,
        prompt: "PRIVATE-CONTENT",
      });
      runtime.record("mcp.delegated_task.finished", {
        status: "completed",
        callerProvider: "codex",
        targetProvider: "claudeAgent",
        durationSeconds: 90,
      });
      for (const outcome of ["started", "completed", "failed"] as const) {
        runtime.record(`scient.operation.${outcome}`, {
          operationKind: "latex-visual-edit",
          trigger: "user",
          durationMs: 1234,
          failureClass: "unknown",
          source: "PRIVATE-CONTENT",
          documentId: "PRIVATE-DOCUMENT",
          revision: "PRIVATE-REVISION",
          error: "PRIVATE-ERROR",
        });
      }
      expect(await runtime.flush()).toBe(23);
      expect(await runtime.pendingCount()).toBe(0);
      expect(store.sqlite.prepare("SELECT count(*) AS n FROM analytics_events").get()!.n).toBe(23);
      expect(uploads[0]!.body).not.toContain("PRIVATE");
      const exportRequest = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
      vi.stubGlobal("fetch", exportRequest);
      expect(
        await flushPendingEvents({
          ...env,
          DESKTOP_POSTHOG_EXPORT_ENABLED: "true",
          POSTHOG_PROJECT_TOKEN: "synthetic",
        }),
      ).toBe(23);
      expect(exportRequest).toHaveBeenCalledOnce();
      expect(String(exportRequest.mock.calls[0]![1].body)).not.toContain("PRIVATE");
      const exported = JSON.parse(String(exportRequest.mock.calls[0]![1].body));
      expect(
        exported.batch.find((event: { event: string }) => event.event === "install.owner_observed")
          .properties,
      ).toMatchObject({ ownerSource: "openai", ownerId, observedBy: "server" });
      expect(
        exported.batch.find((event: { event: string }) => event.event === "provider.turn.usage")
          .properties,
      ).toMatchObject({ createdBy: "user", creationSource: "web", scheduled: false });
      for (const provider of ["scient", "omp", "muse", "acpRegistry"]) {
        const events = exported.batch.filter(
          (event: { properties: { provider?: string } }) => event.properties.provider === provider,
        );
        expect(events.map((event: { event: string }) => event.event).sort()).toEqual([
          "provider.installation.observed",
          "provider.turn.sent",
        ]);
        expect(events[0].properties.contractRevision).toBe("9");
      }
      expect(
        exported.batch.find((event: { event: string }) => event.event === "feature.viewed")
          .properties,
      ).toMatchObject({ feature: "latex-visual", contractRevision: "9" });
      const visualOutcomes = exported.batch.filter(
        (event: { properties: { operationKind?: string } }) =>
          event.properties.operationKind === "latex-visual-edit",
      );
      expect(visualOutcomes).toHaveLength(3);
      for (const event of visualOutcomes)
        expect(event.properties).toMatchObject({
          trigger: "user",
          durationBucket: "1-5s",
          failureClass: "unknown",
          contractRevision: "9",
        });
      expect(
        exported.batch.find((event: { event: string }) => event.event === "provider.turn.usage")
          .properties,
      ).toMatchObject({
        provider: "codex",
        modelKey: "other",
        usageStatus: "complete",
        inputTokens: 12345,
        outputTokens: 678,
        cachedInputTokens: 200,
      });
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
