import { afterEach, describe, expect, it, vi } from "vitest";

import { onRequestPost } from "./consent";

function createDatabase() {
  const run = vi.fn().mockResolvedValue({ success: true });
  const bind = vi.fn(() => ({ run }));
  const prepare = vi.fn(() => ({ bind }));
  const batch = vi.fn().mockResolvedValue([]);
  return { database: { prepare, batch } as unknown as D1Database, bind, prepare, batch };
}

function createContext(level: unknown, cookie?: string) {
  const database = createDatabase();
  const request = new Request("https://scientfactory.com/api/consent", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://scientfactory.com",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify({ level }),
  });
  return {
    context: { request, env: { DOWNLOAD_DB: database.database } } as Parameters<
      typeof onRequestPost
    >[0],
    database,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("website analytics consent", () => {
  it("creates a random first-party visitor after product consent", async () => {
    const { context, database } = createContext("product");
    const response = await onRequestPost(context);

    expect(response.status).toBe(200);
    const cookies = response.headers.getSetCookie();
    expect(cookies).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^sf_analytics=product;/),
        expect.stringMatching(/^sf_visitor=visitor:[0-9a-f-]+;/),
      ]),
    );
    expect(database.batch).toHaveBeenCalledOnce();
    expect(database.bind).toHaveBeenCalledWith(
      expect.stringMatching(/^visitor:/),
      expect.stringMatching(/^visitor:/),
      "product",
      expect.any(String),
      expect.any(String),
    );
  });

  it("removes persistent identity when essential-only is selected", async () => {
    const { context, database } = createContext(
      "essential",
      "sf_analytics=product; sf_visitor=visitor:16ace444-e7c3-4b26-893f-98713188ae52",
    );
    const response = await onRequestPost(context);

    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie()).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^sf_analytics=essential;/),
        expect.stringContaining("sf_visitor=; Path=/; Max-Age=0"),
      ]),
    );
    expect(database.batch).toHaveBeenCalledOnce();
    expect(database.bind).toHaveBeenCalledWith(
      expect.any(String),
      "visitor:16ace444-e7c3-4b26-893f-98713188ae52",
      "essential",
      "2026-07-identity-v1",
      expect.any(String),
    );
  });

  it("rejects a cross-origin consent submission", async () => {
    const { context, database } = createContext("product");
    Object.defineProperty(context, "request", {
      value: new Request("https://scientfactory.com/api/consent", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://attacker.example" },
        body: JSON.stringify({ level: "product" }),
      }),
    });

    const response = await onRequestPost(context);
    expect(response.status).toBe(403);
    expect(database.prepare).not.toHaveBeenCalled();
  });
});
