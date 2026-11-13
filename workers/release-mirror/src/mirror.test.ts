import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseMirrorPointer } from "../../../functions/_lib/release-mirror";
import { syncDesktopMirror } from "./mirror";

interface HandoffFixture {
  readonly schemaVersion: 1;
  readonly product: "Scient";
  readonly version: string;
  readonly tag: string;
  readonly source: { readonly repository: string; readonly commit: string; readonly tree: string };
  readonly assets: ReadonlyArray<{
    readonly name: string;
    readonly size: number;
    readonly sha256: string;
  }>;
}

function handoffFor(version: string, digests = "1234"): HandoffFixture {
  return {
    schemaVersion: 1,
    product: "Scient",
    version,
    tag: `v${version}`,
    source: {
      repository: "ScientFactory/scient-desktop",
      commit: "a".repeat(40),
      tree: "b".repeat(40),
    },
    assets: [
      { name: `Scient-${version}-arm64.dmg`, size: 3, sha256: digests[0]!.repeat(64) },
      { name: `Scient-${version}-x64.dmg`, size: 3, sha256: digests[1]!.repeat(64) },
      { name: `Scient-${version}-x64.exe`, size: 3, sha256: digests[2]!.repeat(64) },
      { name: `Scient-${version}-x86_64.AppImage`, size: 3, sha256: digests[3]!.repeat(64) },
      { name: "latest.yml", size: 3, sha256: "5".repeat(64) },
    ],
  };
}

const handoff = handoffFor("0.6.28");
const NOW = new Date("2026-11-13T12:00:00.000Z");
const HANDOFF_URL =
  "https://github.com/ScientFactory/scient-desktop/releases/latest/download/scient-release-handoff.json";
const STABLE = "scient-desktop/stable.json";

interface StoredObject {
  readonly body: string;
  readonly etag: string;
  readonly customMetadata?: Record<string, string>;
}

/**
 * An in-memory bucket with R2's write rules used here: a write whose bytes miss the declared
 * SHA-256 is refused, and `If-None-Match: *` / `etagMatches` writes return null when they fail.
 */
function memoryBucket(initial: Record<string, string> = {}) {
  let version = 0;
  const objects = new Map<string, StoredObject>(
    Object.entries(initial).map(([key, body]) => [key, { body, etag: `e${(version += 1)}` }]),
  );
  const writes: string[] = [];
  const describe = (object: StoredObject | undefined) =>
    object
      ? {
          size: object.body.length,
          etag: object.etag,
          customMetadata: object.customMetadata ?? {},
          text: async () => object.body,
        }
      : null;
  const bucket = {
    head: vi.fn(async (key: string) => describe(objects.get(key))),
    get: vi.fn(async (key: string) => describe(objects.get(key))),
    put: vi.fn(async (key: string, value: ReadableStream | string, options?: R2PutOptions) => {
      const onlyIf = options?.onlyIf;
      const existing = objects.get(key);
      if (onlyIf instanceof Headers && onlyIf.get("If-None-Match") === "*" && existing) {
        return null;
      }
      if (onlyIf && !(onlyIf instanceof Headers) && onlyIf.etagMatches !== existing?.etag) {
        return null;
      }
      const body = typeof value === "string" ? value : await new Response(value).text();
      if (options?.sha256 !== undefined && options.sha256 !== `${body[0]}`.repeat(64)) {
        throw new Error("put: The SHA-256 checksum you specified did not match what we received.");
      }
      const stored = {
        body,
        etag: `e${(version += 1)}`,
        customMetadata: options?.customMetadata as Record<string, string> | undefined,
      };
      objects.set(key, stored);
      writes.push(key);
      return describe(stored);
    }),
  };
  return { bucket: bucket as unknown as R2Bucket, objects, writes, put: bucket.put };
}

/**
 * GitHub's latest handoff is `latest()`; every tag's installers stay downloadable, each served as
 * three copies of its digest's first character.
 */
function githubFetch(
  latest: () => HandoffFixture = () => handoff,
  overrides: Record<string, () => Response | Promise<Response>> = {},
) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (overrides[url]) return overrides[url]!();
    if (url === HANDOFF_URL) {
      return Response.json(latest(), {
        headers: { "Last-Modified": "Tue, 10 Nov 2026 16:14:08 GMT" },
      });
    }
    const [tag = "", encodedName = ""] = url.split("/").slice(-2);
    const release = latest().tag === tag ? latest() : handoffFor(tag.slice(1));
    const asset = release.assets.find(
      (candidate) => candidate.name === decodeURIComponent(encodedName),
    );
    if (!asset) return new Response(null, { status: 404 });
    const body = asset.sha256[0]!.repeat(3);
    return new Response(body, { headers: { "Content-Length": String(body.length) } });
  });
}

function pointerTag(objects: Map<string, StoredObject>): string | undefined {
  const pointer = objects.get(STABLE);
  return pointer ? parseMirrorPointer(JSON.parse(pointer.body)).handoff.tag : undefined;
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
      superseded: false,
    });
    expect(writes.at(-1)).toBe(STABLE);
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
    expect(JSON.parse(objects.get(STABLE)!.body)).toEqual({
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

    expect(result).toEqual({ tag: "v0.6.28", copied: [], promoted: false, superseded: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(first.objects.get(STABLE)!.body)).toMatchObject({
      mirroredAt: "2026-11-13T11:00:00.000Z",
      checkedAt: NOW.toISOString(),
    });
  });

  it("never replaces a published installer whose digest the handoff later changes", async () => {
    const { bucket, objects } = memoryBucket();
    vi.stubGlobal("fetch", githubFetch());
    await syncDesktopMirror(bucket, NOW);
    const pointerBefore = objects.get(STABLE)!.body;
    vi.stubGlobal(
      "fetch",
      githubFetch(() => handoffFor("0.6.28", "9234")),
    );

    await expect(syncDesktopMirror(bucket, NOW)).rejects.toThrow(/never replaced/);
    expect(objects.get("scient-desktop/v0.6.28/Scient-0.6.28-arm64.dmg")?.body).toBe("111");
    expect(objects.get(STABLE)!.body).toBe(pointerBefore);
  });

  it("keeps a newer promotion when an older, slower run finishes later", async () => {
    const { bucket, objects } = memoryBucket();
    let latest = handoffFor("0.6.28");
    let releaseSlowCopy!: () => void;
    const slowCopy = new Promise<void>((resolve) => {
      releaseSlowCopy = resolve;
    });
    vi.stubGlobal(
      "fetch",
      githubFetch(() => latest, {
        "https://github.com/ScientFactory/scient-desktop/releases/download/v0.6.28/Scient-0.6.28-x64.exe":
          async () => {
            await slowCopy;
            return new Response("333", { headers: { "Content-Length": "3" } });
          },
      }),
    );

    const olderRun = syncDesktopMirror(bucket, NOW);
    await vi.waitFor(() =>
      expect(objects.has("scient-desktop/v0.6.28/Scient-0.6.28-x64.dmg")).toBe(true),
    );
    latest = handoffFor("0.6.29");
    await expect(syncDesktopMirror(bucket, NOW)).resolves.toMatchObject({ promoted: true });
    releaseSlowCopy();

    await expect(olderRun).resolves.toMatchObject({
      tag: "v0.6.28",
      promoted: false,
      superseded: true,
    });
    expect(pointerTag(objects)).toBe("v0.6.29");
  });

  it("keeps a newer promotion when an older run's GitHub answer arrives late", async () => {
    const { bucket, objects } = memoryBucket();
    vi.stubGlobal(
      "fetch",
      githubFetch(() => handoffFor("0.6.28")),
    );
    await syncDesktopMirror(bucket, NOW);
    let releaseOldAnswer!: () => void;
    const oldAnswer = new Promise<void>((resolve) => {
      releaseOldAnswer = resolve;
    });
    let handoffRequests = 0;
    vi.stubGlobal(
      "fetch",
      githubFetch(() => handoffFor("0.6.29"), {
        [HANDOFF_URL]: async () => {
          handoffRequests += 1;
          // The first request is answered late, with the release that was latest when it began.
          if (handoffRequests === 1) {
            await oldAnswer;
            return Response.json(handoffFor("0.6.28"));
          }
          return Response.json(handoffFor("0.6.29"));
        },
      }),
    );

    const olderRun = syncDesktopMirror(bucket, NOW);
    await vi.waitFor(() => expect(handoffRequests).toBe(1));
    await expect(syncDesktopMirror(bucket, NOW)).resolves.toMatchObject({
      tag: "v0.6.29",
      promoted: true,
    });
    releaseOldAnswer();

    await expect(olderRun).resolves.toMatchObject({ tag: "v0.6.28", superseded: true });
    expect(pointerTag(objects)).toBe("v0.6.29");
  });

  it("leaves the previous pointer in place when an installer does not match the handoff", async () => {
    const previous = JSON.stringify({ schemaVersion: 1, marker: "previous" });
    const { bucket, objects } = memoryBucket({ [STABLE]: previous });
    vi.stubGlobal(
      "fetch",
      githubFetch(undefined, {
        "https://github.com/ScientFactory/scient-desktop/releases/download/v0.6.28/Scient-0.6.28-x64.dmg":
          () => new Response("999", { headers: { "Content-Length": "3" } }),
      }),
    );

    await expect(syncDesktopMirror(bucket, NOW)).rejects.toThrow(/SHA-256/);
    expect(objects.get(STABLE)?.body).toBe(previous);
    expect(objects.has("scient-desktop/v0.6.28/Scient-0.6.28-x64.dmg")).toBe(false);
  });

  it("refuses an installer whose declared size differs from the handoff", async () => {
    const { bucket, objects } = memoryBucket();
    vi.stubGlobal(
      "fetch",
      githubFetch(undefined, {
        "https://github.com/ScientFactory/scient-desktop/releases/download/v0.6.28/Scient-0.6.28-arm64.dmg":
          () => new Response("1111", { headers: { "Content-Length": "4" } }),
      }),
    );

    await expect(syncDesktopMirror(bucket, NOW)).rejects.toThrow(/4 bytes/);
    expect(objects.size).toBe(0);
  });

  it("does nothing when GitHub's handoff is unavailable", async () => {
    const { bucket, writes } = memoryBucket();
    vi.stubGlobal(
      "fetch",
      githubFetch(undefined, { [HANDOFF_URL]: () => new Response(null, { status: 429 }) }),
    );

    await expect(syncDesktopMirror(bucket, NOW)).rejects.toThrow(/429/);
    expect(writes).toEqual([]);
  });
});
