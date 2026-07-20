import { afterEach, describe, expect, it, vi } from "vitest";

import { onRequestPost } from "./events";

function createDatabase() {
  const run = vi.fn().mockResolvedValue({ success: true });
  const bind = vi.fn(() => ({ run }));
  const prepare = vi.fn(() => ({ bind }));
  const batch = vi.fn().mockResolvedValue([]);
  return { database: { prepare, batch } as unknown as D1Database, bind, prepare, run, batch };
}

function createContext(
  body: unknown,
  options?: { readonly origin?: string; readonly url?: string; readonly cookie?: string },
) {
  const database = createDatabase();
  const url = options?.url ?? "https://scientfactory.com/api/events";
  const request = new Request(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: options?.origin ?? new URL(url).origin,
      ...(options?.cookie ? { Cookie: options.cookie } : {}),
    },
    body: JSON.stringify(body),
  });
  const context = {
    request,
    env: { DOWNLOAD_DB: database.database },
    waitUntil: vi.fn(),
  } as unknown as Parameters<typeof onRequestPost>[0] & {
    waitUntil: ReturnType<typeof vi.fn>;
  };
  return { context, database };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("browser event endpoint", () => {
  it("records an anonymous page view", async () => {
    const { context, database } = createContext({
      event_name: "page_viewed",
      page_path: "/docs?private=not-stored",
    });

    const response = await onRequestPost(context);

    expect(response.status).toBe(204);
    await context.waitUntil.mock.calls[0]?.[0];
    expect(database.bind).toHaveBeenCalledWith(
      expect.any(String),
      "page_viewed",
      "product",
      expect.any(String),
      expect.stringMatching(/^web-event:/),
      JSON.stringify({ page_path: "/docs" }),
      "event",
      expect.stringMatching(/^web-event:/),
      null,
      "essential",
    );
  });

  it("records only the host and path for an outbound link", async () => {
    const { context, database } = createContext({
      event_name: "outbound_link_clicked",
      page_path: "/about",
      destination_url: "https://github.com/ScientFactory/scient-desktop?token=discarded#readme",
    });

    const response = await onRequestPost(context);

    expect(response.status).toBe(204);
    await context.waitUntil.mock.calls[0]?.[0];
    expect(database.bind).toHaveBeenCalledWith(
      expect.any(String),
      "outbound_link_clicked",
      "product",
      expect.any(String),
      expect.stringMatching(/^web-event:/),
      JSON.stringify({
        page_path: "/about",
        destination_host: "github.com",
        destination_path: "/ScientFactory/scient-desktop",
      }),
      "event",
      expect.stringMatching(/^web-event:/),
      null,
      "essential",
    );
  });

  it("connects consented events to a stable visitor and session", async () => {
    const visitorId = "visitor:16ace444-e7c3-4b26-893f-98713188ae52";
    const sessionId = "session:8e0ee7d5-2c4b-48b6-8209-08f1e536f665";
    const { context, database } = createContext(
      { event_name: "page_viewed", page_path: "/", session_id: sessionId },
      { cookie: `sf_analytics=product; sf_visitor=${visitorId}` },
    );

    const response = await onRequestPost(context);

    expect(response.status).toBe(204);
    await context.waitUntil.mock.calls[0]?.[0];
    expect(database.bind).toHaveBeenCalledWith(
      visitorId,
      visitorId,
      expect.any(String),
      expect.any(String),
    );
    expect(database.bind).toHaveBeenCalledWith(
      expect.any(String),
      "page_viewed",
      "product",
      expect.any(String),
      visitorId,
      JSON.stringify({ page_path: "/" }),
      "web_visitor",
      visitorId,
      sessionId,
      "product",
    );
  });

  it("rejects server-owned event names from browser payloads", async () => {
    const { context, database } = createContext({
      event_name: "download_clicked",
      page_path: "/download",
    });

    const response = await onRequestPost(context);

    expect(response.status).toBe(400);
    expect(database.prepare).not.toHaveBeenCalled();
  });

  it("rejects non-object JSON payloads", async () => {
    const { context, database } = createContext(null);

    const response = await onRequestPost(context);

    expect(response.status).toBe(400);
    expect(database.prepare).not.toHaveBeenCalled();
  });

  it("rejects cross-origin submissions", async () => {
    const { context, database } = createContext(
      { event_name: "page_viewed", page_path: "/" },
      { origin: "https://attacker.example" },
    );

    const response = await onRequestPost(context);

    expect(response.status).toBe(403);
    expect(database.prepare).not.toHaveBeenCalled();
  });

  it("does not pollute production data from local previews", async () => {
    const { context, database } = createContext(
      { event_name: "page_viewed", page_path: "/" },
      { url: "http://127.0.0.1:8788/api/events" },
    );

    const response = await onRequestPost(context);

    expect(response.status).toBe(204);
    expect(database.prepare).not.toHaveBeenCalled();
  });
});
