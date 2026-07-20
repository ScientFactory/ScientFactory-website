import { afterEach, describe, expect, it, vi } from "vitest";

import { onRequestGet, onRequestHead } from "./[asset]";

const releaseFixture = {
  tag_name: "v0.5.7",
  name: "Scient v0.5.7",
  html_url: "https://github.com/ScientFactory/scient-desktop/releases/tag/v0.5.7",
  published_at: "2026-07-20T00:00:00Z",
  prerelease: false,
  assets: [
    {
      name: "Scient-0.5.7-arm64.dmg",
      browser_download_url:
        "https://github.com/ScientFactory/scient-desktop/releases/download/v0.5.7/Scient-0.5.7-arm64.dmg",
      content_type: "application/x-apple-diskimage",
      size: 125_000_000,
    },
  ],
};

function createDatabase(run = vi.fn().mockResolvedValue({ success: true })) {
  const bind = vi.fn(() => ({ run }));
  const prepare = vi.fn(() => ({ bind }));
  return { database: { prepare } as unknown as D1Database, prepare, bind, run };
}

function createContext(
  asset = "macArm64",
  database = createDatabase().database,
): Parameters<typeof onRequestGet>[0] & { waitUntil: ReturnType<typeof vi.fn> } {
  return {
    request: new Request(`https://scientfactory.com/api/download/${asset}`),
    env: { DOWNLOAD_DB: database },
    params: { asset },
    data: undefined,
    functionPath: "api/download/[asset]",
    next: vi.fn(),
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  } as unknown as Parameters<typeof onRequestGet>[0] & { waitUntil: ReturnType<typeof vi.fn> };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("tracked download redirect", () => {
  it("records a click and redirects to the official installer", async () => {
    const db = createDatabase();
    const context = createContext("macArm64", db.database);
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(Response.json(releaseFixture)));

    const response = await onRequestGet(context);

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(releaseFixture.assets[0]?.browser_download_url);
    expect(context.waitUntil).toHaveBeenCalledTimes(1);
    await context.waitUntil.mock.calls[0]?.[0];
    expect(db.bind).toHaveBeenCalledWith(
      "download_clicked",
      "/download",
      "macArm64",
      "v0.5.7",
      "Scient-0.5.7-arm64.dmg",
      "github.com",
      "/ScientFactory/scient-desktop/releases/download/v0.5.7/Scient-0.5.7-arm64.dmg",
      null,
      null,
    );
  });

  it("does not let a database failure block a valid redirect", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const db = createDatabase(vi.fn().mockRejectedValue(new Error("database unavailable")));
    const context = createContext("macArm64", db.database);
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(Response.json(releaseFixture)));

    const response = await onRequestGet(context);

    expect(response.status).toBe(302);
    await context.waitUntil.mock.calls[0]?.[0];
  });

  it("records a ScientFactory-side failure when resolution fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const db = createDatabase();
    const context = createContext("macArm64", db.database);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 })),
    );

    const response = await onRequestGet(context);

    expect(response.status).toBe(503);
    await context.waitUntil.mock.calls[0]?.[0];
    expect(db.bind).toHaveBeenCalledWith(
      "download_failed",
      "/download",
      "macArm64",
      null,
      null,
      null,
      null,
      "release_fetch",
      "upstream_unavailable",
    );
  });

  it("rejects unknown asset keys before contacting GitHub", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const response = await onRequestGet(createContext("unknown"));

    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("supports an untracked HEAD verification", async () => {
    const context = createContext();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(Response.json(releaseFixture)));

    const response = await onRequestHead(context);

    expect(response.status).toBe(302);
    expect(context.waitUntil).not.toHaveBeenCalled();
  });
});
