import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LatestReleaseResolutionError, resolveLatestDesktopRelease } from "./latest-release";

const handoffFixture = {
  schemaVersion: 1,
  product: "Scient",
  version: "0.6.5",
  tag: "v0.6.5",
  source: {
    repository: "ScientFactory/scient-desktop-next",
    commit: "a".repeat(40),
    tree: "b".repeat(40),
  },
  assets: [
    { name: "Scient-0.6.5-arm64.dmg", size: 125_000_000, sha256: "c".repeat(64) },
    { name: "Scient-0.6.5-x64.dmg", size: 129_000_000, sha256: "d".repeat(64) },
    { name: "Scient-0.6.5-x64.exe", size: 98_000_000, sha256: "e".repeat(64) },
    {
      name: "Scient-0.6.5-x86_64.AppImage",
      size: 112_000_000,
      sha256: "f".repeat(64),
    },
  ],
};

const mirroredHandoff = {
  ...handoffFixture,
  version: "0.6.4",
  tag: "v0.6.4",
  assets: handoffFixture.assets.map((asset) => ({
    ...asset,
    name: asset.name.replace("0.6.5", "0.6.4"),
  })),
};

const NOW = Date.parse("2026-11-13T12:00:00.000Z");

function handoffResponse(headers?: HeadersInit): Response {
  return Response.json(handoffFixture, {
    headers: { "Last-Modified": "Sat, 22 Aug 2026 01:50:58 GMT", ...headers },
  });
}

function mirrorBucket(checkedAt: string | null, body?: string): R2Bucket {
  const text =
    body ??
    JSON.stringify({
      schemaVersion: 1,
      handoff: mirroredHandoff,
      publishedAt: "2026-11-01T00:00:00.000Z",
      mirroredAt: "2026-11-01T00:05:00.000Z",
      checkedAt,
    });
  return {
    get: vi.fn(async () =>
      checkedAt === null && body === undefined
        ? null
        : { size: text.length, text: async () => text },
    ),
  } as unknown as R2Bucket;
}

function context(bucket?: R2Bucket) {
  const pending: Array<Promise<unknown>> = [];
  return {
    request: new Request("https://scientfactory.com/api/releases/latest"),
    env: bucket ? { DESKTOP_DOWNLOADS: bucket } : {},
    waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    pending,
  };
}

function emptyCache() {
  const put = vi.fn();
  vi.stubGlobal("caches", {
    default: { match: vi.fn().mockResolvedValue(undefined), put, delete: vi.fn() },
  });
  return put;
}

function upstreamError(upstream: object) {
  return expect.objectContaining<Partial<LatestReleaseResolutionError>>({
    stage: "release_fetch",
    reason: "upstream_unavailable",
    upstream: expect.objectContaining(upstream),
  });
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("latest release resolver", () => {
  it("shares one normalized cache entry across cold and subsequent requests", async () => {
    let stored: Response | undefined;
    const match = vi.fn(async (_key: Request) => stored?.clone());
    const put = vi.fn(async (_key: Request, response: Response) => {
      stored = response.clone();
    });
    vi.stubGlobal("caches", { default: { match, put, delete: vi.fn() } });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(handoffResponse());
    vi.stubGlobal("fetch", fetchMock);

    const firstContext = context();
    await expect(resolveLatestDesktopRelease(firstContext)).resolves.toMatchObject({
      tag_name: "v0.6.5",
    });
    await Promise.all(firstContext.pending);

    await expect(resolveLatestDesktopRelease(context())).resolves.toMatchObject({
      tag_name: "v0.6.5",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledTimes(1);
    const key = match.mock.calls[0]?.[0];
    expect(new URL(key.url).searchParams.toString()).toBe(
      new URLSearchParams({
        source: "ScientFactory/scient-desktop",
        schema: "handoff-v2",
      }).toString(),
    );
  });

  it("serves a fresh mirror without contacting GitHub", async () => {
    vi.useFakeTimers({ now: NOW });
    emptyCache();
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const release = await resolveLatestDesktopRelease(
      context(mirrorBucket("2026-11-13T11:55:00.000Z")),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(release.tag_name).toBe("v0.6.4");
    expect(release.assets[0]?.browser_download_url).toBe(
      "https://downloads.scientfactory.com/scient-desktop/v0.6.4/Scient-0.6.4-arm64.dmg",
    );
  });

  it("prefers GitHub over a mirror the worker has not confirmed recently", async () => {
    vi.useFakeTimers({ now: NOW });
    emptyCache();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(handoffResponse()));

    const release = await resolveLatestDesktopRelease(
      context(mirrorBucket("2026-11-13T05:00:00.000Z")),
    );

    expect(release.tag_name).toBe("v0.6.5");
    expect(release.assets[0]?.browser_download_url).toContain("github.com");
  });

  it("falls back to a stale mirror when GitHub refuses, without retrying the refusal", async () => {
    vi.useFakeTimers({ now: NOW });
    emptyCache();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("Too many requests", { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);

    const release = await resolveLatestDesktopRelease(
      context(mirrorBucket("2026-11-01T00:05:00.000Z")),
    );

    expect(release.tag_name).toBe("v0.6.4");
    expect(release.assets[0]?.browser_download_url).toContain("downloads.scientfactory.com");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ignores an unreadable mirror pointer and resolves from GitHub", async () => {
    emptyCache();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(handoffResponse()));

    await expect(
      resolveLatestDesktopRelease(context(mirrorBucket(null, '{"schemaVersion":1}'))),
    ).resolves.toMatchObject({ tag_name: "v0.6.5" });
  });

  it("retries a GitHub server error once", async () => {
    vi.useFakeTimers();
    emptyCache();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 502 }))
      .mockResolvedValueOnce(handoffResponse());
    vi.stubGlobal("fetch", fetchMock);

    const pending = resolveLatestDesktopRelease(context());
    await vi.advanceTimersByTimeAsync(250);

    await expect(pending).resolves.toMatchObject({ tag_name: "v0.6.5" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports GitHub's refusal with its status when there is no mirror", async () => {
    const put = emptyCache();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 429 })),
    );

    await expect(resolveLatestDesktopRelease(context())).rejects.toEqual(
      upstreamError({ status: 429, error: null, attempts: 1 }),
    );
    expect(put).not.toHaveBeenCalled();
  });

  it("rejects an oversized handoff before parsing or caching it", async () => {
    const put = emptyCache();
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(handoffResponse({ "Content-Length": String(64 * 1024 + 1) })),
    );

    await expect(resolveLatestDesktopRelease(context())).rejects.toEqual(
      expect.objectContaining<Partial<LatestReleaseResolutionError>>({
        stage: "release_validation",
        reason: "release_metadata_invalid",
      }),
    );
    expect(put).not.toHaveBeenCalled();
  });

  it("aborts each stalled attempt at the bounded timeout and names the timeout", async () => {
    vi.useFakeTimers();
    emptyCache();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted")));
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const pending = resolveLatestDesktopRelease(context());
    const rejection = expect(pending).rejects.toEqual(
      upstreamError({ status: null, error: "TimeoutError", attempts: 2 }),
    );
    await vi.advanceTimersByTimeAsync(4_000 + 250 + 4_000);
    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("discards an invalid cached value and replaces it from the handoff", async () => {
    let stored: Response | undefined = Response.json({ untrusted: true });
    const deleteCached = vi.fn(async () => {
      stored = undefined;
      return true;
    });
    const put = vi.fn(async (_key: Request, response: Response) => {
      stored = response.clone();
    });
    vi.stubGlobal("caches", {
      default: { match: vi.fn(async () => stored?.clone()), put, delete: deleteCached },
    });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(handoffResponse());
    vi.stubGlobal("fetch", fetchMock);

    const resolutionContext = context();
    await expect(resolveLatestDesktopRelease(resolutionContext)).resolves.toMatchObject({
      tag_name: "v0.6.5",
    });
    await Promise.all(resolutionContext.pending);
    expect(deleteCached).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledTimes(1);
  });
});
