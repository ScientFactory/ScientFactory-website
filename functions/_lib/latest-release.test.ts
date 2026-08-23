import { afterEach, describe, expect, it, vi } from "vitest";

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

function handoffResponse(headers?: HeadersInit): Response {
  return Response.json(handoffFixture, {
    headers: { "Last-Modified": "Sat, 22 Aug 2026 01:50:58 GMT", ...headers },
  });
}

function context() {
  const pending: Array<Promise<unknown>> = [];
  return {
    request: new Request("https://scientfactory.com/api/releases/latest"),
    waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    pending,
  };
}

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
        source: "ScientFactory/scient-desktop-next",
        schema: "handoff-v1",
      }).toString(),
    );
  });

  it("rejects an oversized handoff before parsing or caching it", async () => {
    const put = vi.fn();
    vi.stubGlobal("caches", {
      default: { match: vi.fn().mockResolvedValue(undefined), put, delete: vi.fn() },
    });
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

  it("aborts a stalled handoff request at the bounded timeout", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("caches", {
      default: {
        match: vi.fn().mockResolvedValue(undefined),
        put: vi.fn(),
        delete: vi.fn(),
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(
        (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted")));
          }),
      ),
    );

    const pending = resolveLatestDesktopRelease(context());
    const rejection = expect(pending).rejects.toEqual(
      expect.objectContaining<Partial<LatestReleaseResolutionError>>({
        stage: "release_fetch",
        reason: "upstream_unavailable",
      }),
    );
    await vi.advanceTimersByTimeAsync(8_000);
    await rejection;
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
