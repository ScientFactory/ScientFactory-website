import { afterEach, describe, expect, it, vi } from "vitest";

import { onRequestPost } from "./events";

function createDatabase() {
  const run = vi.fn().mockResolvedValue({ success: true });
  const bind = vi.fn(() => ({ run }));
  const prepare = vi.fn(() => ({ bind }));
  return { database: { prepare } as unknown as D1Database, bind, prepare, run };
}

function createContext(
  body: unknown,
  options?: { readonly origin?: string; readonly url?: string },
) {
  const database = createDatabase();
  const url = options?.url ?? "https://scientfactory.com/api/events";
  const request = new Request(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: options?.origin ?? new URL(url).origin,
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
      "page_viewed",
      "/docs",
      null,
      null,
      null,
      null,
      null,
      null,
      null,
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
      "outbound_link_clicked",
      "/about",
      null,
      null,
      null,
      "github.com",
      "/ScientFactory/scient-desktop",
      null,
      null,
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
