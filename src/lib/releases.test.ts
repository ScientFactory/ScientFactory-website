import { afterEach, describe, expect, it, vi } from "vitest";

import {
  findChecksumAsset,
  findDownloadAsset,
  fetchLatestRelease,
  formatFileSize,
  parseRelease,
} from "./releases";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const releaseFixture = {
  tag_name: "v0.5.5",
  name: "Scient v0.5.5",
  html_url: "https://github.com/ScientFactory/scient-desktop/releases/tag/v0.5.5",
  published_at: "2026-07-19T00:00:00Z",
  prerelease: false,
  assets: [
    {
      name: "Scient-0.5.5-arm64.dmg",
      browser_download_url: "https://example.test/Scient-0.5.5-arm64.dmg",
      content_type: "application/x-apple-diskimage",
      size: 125_000_000,
      digest: "sha256:abc",
    },
    {
      name: "Scient-0.5.5-x64.dmg",
      browser_download_url: "https://example.test/Scient-0.5.5-x64.dmg",
      content_type: "application/x-apple-diskimage",
      size: 129_000_000,
    },
    {
      name: "Scient-0.5.5-x64.exe",
      browser_download_url: "https://example.test/Scient-0.5.5-x64.exe",
      content_type: "application/octet-stream",
      size: 98_000_000,
    },
    {
      name: "Scient-0.5.5-x86_64.AppImage",
      browser_download_url: "https://example.test/Scient-0.5.5-x86_64.AppImage",
      content_type: "application/octet-stream",
      size: 112_000_000,
    },
    {
      name: "SHA256SUMS.txt",
      browser_download_url: "https://example.test/SHA256SUMS.txt",
      content_type: "text/plain",
      size: 512,
    },
  ],
};

describe("release metadata", () => {
  it("parses a valid GitHub release and finds exact platform assets", () => {
    const release = parseRelease(releaseFixture);

    expect(findDownloadAsset(release, "macArm64")?.name).toBe("Scient-0.5.5-arm64.dmg");
    expect(findDownloadAsset(release, "windowsX64")?.name).toBe("Scient-0.5.5-x64.exe");
    expect(findDownloadAsset(release, "linuxX64")?.name).toBe("Scient-0.5.5-x86_64.AppImage");
    expect(findDownloadAsset(release, "macX64")?.name).toBe("Scient-0.5.5-x64.dmg");
    expect(findChecksumAsset(release)?.name).toBe("SHA256SUMS.txt");
  });

  it("rejects malformed or incomplete GitHub responses", () => {
    expect(() => parseRelease({ ...releaseFixture, assets: [{ name: "broken" }] })).toThrow(
      "invalid release response",
    );
    expect(() => parseRelease({ message: "rate limited" })).toThrow("invalid release response");
  });

  it("formats installer sizes for people", () => {
    expect(formatFileSize(125_000_000)).toBe("119 MB");
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(-1)).toBe("");
  });

  it("falls back to GitHub when the same-origin release endpoint is unavailable", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(Response.json(releaseFixture));
    vi.stubGlobal("fetch", fetchMock);

    const release = await fetchLatestRelease({ force: true });

    expect(release.tag_name).toBe("v0.5.5");
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/releases/latest", expect.any(Object));
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.github.com/repos/ScientFactory/scient-desktop/releases/latest",
      expect.any(Object),
    );
  });

  it("coalesces concurrent release requests", async () => {
    let resolveResponse: ((response: Response) => void) | undefined;
    const pendingResponse = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    const fetchMock = vi.fn<typeof fetch>().mockReturnValue(pendingResponse);
    vi.stubGlobal("fetch", fetchMock);

    const first = fetchLatestRelease();
    const second = fetchLatestRelease();
    resolveResponse?.(Response.json(releaseFixture));

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses a fresh session cache without a network request", async () => {
    const getItem = vi.fn(() =>
      JSON.stringify({
        cachedAt: Date.now(),
        release: releaseFixture,
      }),
    );
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("sessionStorage", { getItem, setItem: vi.fn() });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchLatestRelease()).resolves.toMatchObject({ tag_name: "v0.5.5" });
    expect(getItem).toHaveBeenCalledWith("scient-latest-release-v2");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["expired", JSON.stringify({ cachedAt: Date.now() - 16 * 60 * 1000, release: releaseFixture })],
    ["corrupt", "{not-json"],
  ])("refreshes an %s session cache entry", async (_case, cachedValue) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json(releaseFixture));
    vi.stubGlobal("sessionStorage", {
      getItem: vi.fn(() => cachedValue),
      setItem: vi.fn(),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchLatestRelease()).resolves.toMatchObject({ tag_name: "v0.5.5" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("forces a refresh even when the session cache is fresh", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json(releaseFixture));
    vi.stubGlobal("sessionStorage", {
      getItem: vi.fn(() => JSON.stringify({ cachedAt: Date.now(), release: releaseFixture })),
      setItem: vi.fn(),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchLatestRelease({ force: true })).resolves.toMatchObject({
      tag_name: "v0.5.5",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
