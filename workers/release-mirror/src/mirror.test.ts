import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { syncDesktopMirror } from "./mirror";

const handoff = {
  schemaVersion: 1,
  product: "Scient",
  version: "0.6.28",
  tag: "v0.6.28",
  source: {
    repository: "ScientFactory/scient-desktop",
    commit: "a".repeat(40),
    tree: "b".repeat(40),
  },
  assets: [
    { name: "Scient-0.6.28-arm64.dmg", size: 3, sha256: "1".repeat(64) },
    { name: "Scient-0.6.28-x64.dmg", size: 3, sha256: "2".repeat(64) },
    { name: "Scient-0.6.28-x64.exe", size: 3, sha256: "3".repeat(64) },
    { name: "Scient-0.6.28-x86_64.AppImage", size: 3, sha256: "4".repeat(64) },
    { name: "latest.yml", size: 3, sha256: "5".repeat(64) },
  ],
};

const NOW = new Date("2026-11-13T12:00:00.000Z");
const HANDOFF_URL =
  "https://github.com/ScientFactory/scient-desktop/releases/latest/download/scient-release-handoff.json";

interface StoredObject {
  readonly body: string;
  readonly options?: R2PutOptions;
}

/** An in-memory bucket that, like R2, refuses a write whose bytes miss the declared SHA-256. */
function memoryBucket(initial: Record<string, StoredObject> = {}) {
  const objects = new Map(Object.entries(initial));
  const writes: string[] = [];
  const bucket = {
    head: vi.fn(async (key: string) => {
      const object = objects.get(key);
      return object
        ? { size: object.body.length, customMetadata: object.options?.customMetadata ?? {} }
        : null;
    }),
    get: vi.fn(async (key: string) => {
      const object = objects.get(key);
      return object ? { size: object.body.length, text: async () => object.body } : null;
    }),
    put: vi.fn(async (key: string, value: ReadableStream | string, options?: R2PutOptions) => {
      const body = typeof value === "string" ? value : await new Response(value).text();
      if (options?.sha256 !== undefined && options.sha256 !== `${body[0]}`.repeat(64)) {
        throw new Error("put: The SHA-256 checksum you specified did not match what we received.");
      }
      objects.set(key, { body, options });
      writes.push(key);
      return {};
    }),
  };
  return { bucket: bucket as unknown as R2Bucket, objects, writes, put: bucket.put };
}

/** GitHub serves each installer as three copies of the digest's first character. */
function githubFetch(overrides: Record<string, Response> = {}) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (overrides[url]) return overrides[url];
    if (url === HANDOFF_URL) {
      return Response.json(handoff, {
        headers: { "Last-Modified": "Tue, 10 Nov 2026 16:14:08 GMT" },
      });
    }
    const name = decodeURIComponent(url.split("/").pop() ?? "");
    const asset = handoff.assets.find((candidate) => candidate.name === name);
    if (!asset) return new Response(null, { status: 404 });
    const body = asset.sha256[0]!.repeat(3);
    return new Response(body, { headers: { "Content-Length": String(body.length) } });
  });
}

beforeEach(() => {
  vi.stubGlobal(
    "FixedLengthStream",
    class extends TransformStream {
      constructor(_length: number) {
        super();
      }
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("desktop release mirror", () => {
  it("copies every installer with its digest, then promotes the Stable pointer last", async () => {
    const { bucket, objects, writes, put } = memoryBucket();
    vi.stubGlobal("fetch", githubFetch());

    const result = await syncDesktopMirror(bucket, NOW);

    expect(result).toEqual({
      tag: "v0.6.28",
      copied: [
        "Scient-0.6.28-arm64.dmg",
        "Scient-0.6.28-x64.dmg",
        "Scient-0.6.28-x64.exe",
        "Scient-0.6.28-x86_64.AppImage",
      ],
      promoted: true,
    });
    expect(writes.at(-1)).toBe("scient-desktop/stable.json");
    expect(writes).not.toContain("scient-desktop/v0.6.28/latest.yml");
    expect(put).toHaveBeenCalledWith(
      "scient-desktop/v0.6.28/Scient-0.6.28-x64.exe",
      expect.anything(),
      expect.objectContaining({
        sha256: "3".repeat(64),
        customMetadata: { sha256: "3".repeat(64) },
        httpMetadata: expect.objectContaining({
          contentDisposition: 'attachment; filename="Scient-0.6.28-x64.exe"',
        }),
      }),
    );
    expect(JSON.parse(objects.get("scient-desktop/stable.json")!.body)).toEqual({
      schemaVersion: 1,
      handoff,
      publishedAt: "2026-11-10T16:14:08.000Z",
      mirroredAt: NOW.toISOString(),
      checkedAt: NOW.toISOString(),
    });
  });

  it("only refreshes the check time when the current release is already mirrored", async () => {
    const first = memoryBucket();
    vi.stubGlobal("fetch", githubFetch());
    await syncDesktopMirror(first.bucket, new Date("2026-11-13T11:00:00.000Z"));
    const fetchMock = githubFetch();
    vi.stubGlobal("fetch", fetchMock);

    const result = await syncDesktopMirror(first.bucket, NOW);

    expect(result).toEqual({ tag: "v0.6.28", copied: [], promoted: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(first.objects.get("scient-desktop/stable.json")!.body)).toMatchObject({
      mirroredAt: "2026-11-13T11:00:00.000Z",
      checkedAt: NOW.toISOString(),
    });
  });

  it("leaves the previous pointer in place when an installer does not match the handoff", async () => {
    const previous = JSON.stringify({ schemaVersion: 1, marker: "previous" });
    const { bucket, objects } = memoryBucket({
      "scient-desktop/stable.json": { body: previous },
    });
    vi.stubGlobal(
      "fetch",
      githubFetch({
        "https://github.com/ScientFactory/scient-desktop/releases/download/v0.6.28/Scient-0.6.28-x64.dmg":
          new Response("999", { headers: { "Content-Length": "3" } }),
      }),
    );

    await expect(syncDesktopMirror(bucket, NOW)).rejects.toThrow(/SHA-256/);
    expect(objects.get("scient-desktop/stable.json")?.body).toBe(previous);
    expect(objects.has("scient-desktop/v0.6.28/Scient-0.6.28-x64.dmg")).toBe(false);
  });

  it("refuses an installer whose declared size differs from the handoff", async () => {
    const { bucket, objects } = memoryBucket();
    vi.stubGlobal(
      "fetch",
      githubFetch({
        "https://github.com/ScientFactory/scient-desktop/releases/download/v0.6.28/Scient-0.6.28-arm64.dmg":
          new Response("1111", { headers: { "Content-Length": "4" } }),
      }),
    );

    await expect(syncDesktopMirror(bucket, NOW)).rejects.toThrow(/4 bytes/);
    expect(objects.size).toBe(0);
  });

  it("does nothing when GitHub's handoff is unavailable", async () => {
    const { bucket, writes } = memoryBucket();
    vi.stubGlobal("fetch", githubFetch({ [HANDOFF_URL]: new Response(null, { status: 429 }) }));

    await expect(syncDesktopMirror(bucket, NOW)).rejects.toThrow(/429/);
    expect(writes).toEqual([]);
  });
});
