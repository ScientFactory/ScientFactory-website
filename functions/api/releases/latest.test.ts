import { afterEach, describe, expect, it, vi } from "vitest";

import { onRequestGet } from "./latest";

const releaseFixture = {
  tag_name: "v0.5.6",
  name: "Scient v0.5.6",
  html_url: "https://github.com/ScientFactory/scient-desktop-next/releases/tag/v0.5.6",
  published_at: "2026-07-19T00:00:00Z",
  prerelease: false,
  assets: [
    {
      name: "Scient-0.5.6-arm64.dmg",
      browser_download_url: "https://example.test/Scient-0.5.6-arm64.dmg",
      content_type: "application/x-apple-diskimage",
      size: 125_000_000,
    },
  ],
};

const handoffFixture = {
  schemaVersion: 1,
  product: "Scient",
  version: "0.5.6",
  tag: "v0.5.6",
  source: {
    repository: "ScientFactory/scient-desktop-next",
    commit: "a".repeat(40),
    tree: "b".repeat(40),
  },
  assets: [
    {
      name: "Scient-0.5.6-arm64.dmg",
      size: 125_000_000,
      sha256: "c".repeat(64),
    },
  ],
};

function handoffResponse(value: unknown = handoffFixture): Response {
  return Response.json(value, {
    headers: { "Last-Modified": "Sun, 19 Jul 2026 00:00:00 GMT" },
  });
}

function createContext() {
  return {
    request: new Request("https://scientfactory.com/api/releases/latest?ignored=true"),
    waitUntil: vi.fn(),
  } as unknown as Parameters<typeof onRequestGet>[0];
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("latest release Pages Function", () => {
  it("returns a fresh edge-cache response without contacting GitHub", async () => {
    const cached = Response.json(releaseFixture, { headers: { "X-Cache-Test": "hit" } });
    const match = vi.fn().mockResolvedValue(cached);
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("caches", { default: { match, put: vi.fn() } });
    vi.stubGlobal("fetch", fetchMock);

    const response = await onRequestGet(createContext());

    expect(response.headers.get("X-Cache-Test")).toBe("hit");
    const cacheRequest = match.mock.calls[0]?.[0] as Request;
    expect(new URL(cacheRequest.url).searchParams.get("source")).toBe(
      "ScientFactory/scient-desktop-next",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("validates and caches a successful GitHub response", async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const context = createContext();
    vi.stubGlobal("caches", {
      default: { match: vi.fn().mockResolvedValue(undefined), put },
    });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(handoffResponse());
    vi.stubGlobal("fetch", fetchMock);

    const response = await onRequestGet(context);

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=300");
    await expect(response.json()).resolves.toMatchObject({ tag_name: "v0.5.6" });
    expect(context.waitUntil).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://github.com/ScientFactory/scient-desktop-next/releases/latest/download/scient-release-handoff.json",
      expect.any(Object),
    );
  });

  it("returns a non-cacheable 503 when GitHub has no public release", async () => {
    vi.stubGlobal("caches", {
      default: { match: vi.fn().mockResolvedValue(undefined), put: vi.fn() },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 })),
    );

    const response = await onRequestGet(createContext());

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("returns a non-cacheable 503 for malformed upstream metadata", async () => {
    vi.stubGlobal("caches", {
      default: { match: vi.fn().mockResolvedValue(undefined), put: vi.fn() },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(handoffResponse({ message: "bad" })),
    );

    const response = await onRequestGet(createContext());

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});
