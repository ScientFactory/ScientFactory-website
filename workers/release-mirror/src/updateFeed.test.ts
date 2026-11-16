import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { desktopMirrorUrl, desktopUpdateFeedUrl } from "../../../src/lib/release-source";
import { syncUpdateFeed } from "./updateFeed";

// The platform's WebCrypto, which both Node and Workers provide, captured before tests stub it.
const subtle = crypto.subtle;
const digest = async (algorithm: string, bytes: BufferSource) =>
  new Uint8Array(await subtle.digest(algorithm, bytes));
const sha256 = async (body: string) =>
  [...(await digest("SHA-256", new TextEncoder().encode(body)))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
const sha512 = async (body: string) =>
  btoa(String.fromCharCode(...(await digest("SHA-512", new TextEncoder().encode(body)))));

interface Release {
  readonly repository: string;
  readonly version: string;
  readonly channel: "stable" | "beta";
  /** Every published file's bytes, by name, including the manifests. */
  readonly files: Map<string, string>;
  readonly handoff: Record<string, unknown>;
}

/** A release shaped like the desktop workflow's: three manifests, their payloads and blockmaps. */
async function release(
  version: string,
  channel: "stable" | "beta" = "stable",
  tamper: {
    readonly sha512Of?: string;
    readonly omitPayload?: string;
    readonly omitBlockmap?: string;
    readonly extraLinux?: boolean;
  } = {},
): Promise<Release> {
  const prefix = channel === "stable" ? "latest" : "beta";
  const repository =
    channel === "stable" ? "ScientFactory/scient-desktop" : "ScientFactory/scient-desktop-beta";
  const payload = (name: string) => `${name} bytes`;
  const names = {
    mac: [
      `Scient-${version}-arm64.zip`,
      `Scient-${version}-arm64.dmg`,
      `Scient-${version}-x64.zip`,
      `Scient-${version}-x64.dmg`,
    ],
    win: [`Scient-${version}-x64.exe`],
    linux: [`Scient-${version}-x86_64.AppImage`],
  };
  const files = new Map<string, string>();
  const manifest = async (list: readonly string[]) => {
    const included = list.filter((name) => name !== tamper.omitPayload);
    const entries: string[] = [];
    for (const name of included) {
      files.set(name, payload(name));
      const recorded = await sha512(tamper.sha512Of === name ? "other bytes" : payload(name));
      entries.push(
        `  - url: ${name}\n    sha512: ${recorded}\n    size: ${payload(name).length}\n`,
      );
    }
    return `version: ${version}\nfiles:\n${entries.join("")}path: ${included[0]}\nsha512: ${await sha512(payload(included[0]!))}\nreleaseDate: '2026-11-16T10:00:00.000Z'\n`;
  };
  files.set(`${prefix}-mac.yml`, await manifest(names.mac));
  files.set(`${prefix}.yml`, await manifest(names.win));
  files.set(`${prefix}-linux.yml`, await manifest(names.linux));
  if (tamper.extraLinux) {
    files.set(
      `${prefix}-linux-arm64.yml`,
      await manifest([`Scient-${version}-arm64.AppImage`, `scient_${version}_arm64.deb`]),
    );
  }
  for (const name of [...names.mac.filter((n) => n.endsWith(".zip")), ...names.win]) {
    if (name === tamper.omitBlockmap) continue;
    files.set(`${name}.blockmap`, `${name} blockmap`);
  }
  files.set(`scient-server-${version}.tgz`, "server");
  const handoff = {
    schemaVersion: 1,
    product: "Scient",
    version,
    tag: `v${version}`,
    distribution: { repository, channel },
    source: {
      repository: "ScientFactory/scient-desktop",
      commit: "a".repeat(40),
      tree: "b".repeat(40),
    },
    assets: await Promise.all(
      [...files].map(async ([name, body]) => ({
        name,
        size: body.length,
        sha256: await sha256(body),
      })),
    ),
  };
  return { repository, version, channel, files, handoff };
}

function atom(repository: string, releases: readonly Release[]): string {
  const entries = releases.map(
    (r) => `<entry>
  <id>tag:github.com,2008:Repository/1/v${r.version}</id>
  <link rel="alternate" type="text/html" href="https://github.com/${repository}/releases/tag/v${r.version}"/>
  <title>Scient v${r.version}</title>
  <content type="html">&lt;p&gt;Notes for ${r.version} &amp;amp; more&lt;/p&gt;</content>
</entry>`,
  );
  return `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom">${entries.join("")}</feed>`;
}

interface StoredObject {
  readonly body: string;
  readonly etag: string;
  readonly httpMetadata?: R2HTTPMetadata;
  readonly customMetadata?: Record<string, string>;
}

/** An in-memory bucket with the R2 write rules the feed relies on. */
function memoryBucket() {
  let version = 0;
  const objects = new Map<string, StoredObject>();
  const writes: string[] = [];
  const describe = (key: string, object: StoredObject | undefined) =>
    object
      ? {
          key,
          size: object.body.length,
          etag: object.etag,
          customMetadata: object.customMetadata ?? {},
          text: async () => object.body,
        }
      : null;
  const bucket = {
    head: vi.fn(async (key: string) => describe(key, objects.get(key))),
    get: vi.fn(async (key: string) => {
      const object = objects.get(key);
      return object === undefined
        ? null
        : { ...describe(key, object), body: new Response(object.body).body };
    }),
    list: vi.fn(async ({ prefix }: R2ListOptions) => ({
      objects: [...objects.keys()]
        .filter((key) => key.startsWith(prefix ?? ""))
        .map((key) => describe(key, objects.get(key))),
      truncated: false,
    })),
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
      if (options?.sha256 !== undefined && options.sha256 !== (await sha256(body))) {
        throw new Error("put: The SHA-256 checksum you specified did not match what we received.");
      }
      const stored = {
        body,
        etag: `e${(version += 1)}`,
        httpMetadata: options?.httpMetadata as R2HTTPMetadata | undefined,
        customMetadata: options?.customMetadata as Record<string, string> | undefined,
      };
      objects.set(key, stored);
      writes.push(key);
      return describe(key, stored);
    }),
  };
  return { bucket: bucket as unknown as R2Bucket, objects, writes };
}

/** GitHub as the feed sees it: each repository's releases, newest Stable as `latest`. */
function github(
  releases: () => readonly Release[],
  overrides: Record<string, () => Response | Promise<Response>> = {},
) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (overrides[url]) return overrides[url]!();
    for (const repository of [
      "ScientFactory/scient-desktop",
      "ScientFactory/scient-desktop-beta",
    ]) {
      const own = releases().filter((r) => r.repository === repository);
      if (url === `https://github.com/${repository}/releases.atom`) {
        return new Response(atom(repository, own));
      }
      const latest = own.at(-1);
      if (
        latest &&
        url ===
          `https://github.com/${repository}/releases/latest/download/scient-release-handoff.json`
      ) {
        return Response.json(latest.handoff);
      }
      const prefix = `https://github.com/${repository}/releases/download/`;
      if (!url.startsWith(prefix)) continue;
      const [tag = "", encoded = ""] = url.slice(prefix.length).split("/");
      const match = own.find((r) => `v${r.version}` === tag);
      const name = decodeURIComponent(encoded);
      if (match && name === "scient-release-handoff.json") return Response.json(match.handoff);
      const body = match?.files.get(name);
      if (body !== undefined) {
        return new Response(body, { headers: { "Content-Length": String(body.length) } });
      }
    }
    return new Response(null, { status: 404 });
  });
}

const FEED = "scient-desktop/updates/stable/";

function feedFile(objects: Map<string, StoredObject>, key: string): string {
  return objects.get(key)!.body;
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
  // Workers' streaming digest, over the platform's WebCrypto.
  vi.stubGlobal("crypto", {
    subtle,
    DigestStream: class extends WritableStream<Uint8Array> {
      readonly digest: Promise<ArrayBuffer>;
      constructor(algorithm: string) {
        const chunks: Uint8Array[] = [];
        let resolve!: (value: ArrayBuffer) => void;
        const result = new Promise<ArrayBuffer>((done) => {
          resolve = done;
        });
        super({
          write: (chunk) => {
            chunks.push(chunk);
          },
          close: async () => {
            const all = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
            let offset = 0;
            for (const chunk of chunks) {
              all.set(chunk, offset);
              offset += chunk.length;
            }
            resolve(await subtle.digest(algorithm, all));
          },
        });
        this.digest = result;
      }
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("desktop update feed", () => {
  it("copies the whole updater set into the version directory, then promotes the manifests", async () => {
    const stable = await release("0.6.30");
    const { bucket, objects, writes } = memoryBucket();
    vi.stubGlobal(
      "fetch",
      github(() => [stable]),
    );

    const result = await syncUpdateFeed(bucket, "stable");

    expect(result.tag).toBe("v0.6.30");
    expect(result.promoted).toEqual(["latest-linux.yml", "latest-mac.yml", "latest.yml"]);
    expect(result.superseded).toEqual([]);
    // Every manifest, payload and blockmap, never the server package.
    expect(result.copied.toSorted()).toEqual(
      [...stable.files.keys()].filter((name) => !name.endsWith(".tgz")).toSorted(),
    );
    // Channel metadata is written only after every object it names.
    const firstFeedWrite = writes.findIndex((key) => key.startsWith(FEED));
    expect(writes.slice(firstFeedWrite).every((key) => key.startsWith(FEED))).toBe(true);

    // The release's manifests are kept byte for byte; the feed copy resolves into them.
    expect(feedFile(objects, "scient-desktop/v0.6.30/latest.yml")).toBe(
      stable.files.get("latest.yml"),
    );
    const windows = feedFile(objects, `${FEED}latest.yml`);
    const urls = [...windows.matchAll(/^ {2}- url: (.+)$/gmu)].map(([, url]) => url!);
    expect(urls.map((url) => new URL(url, `${desktopUpdateFeedUrl("stable")}/`).href)).toEqual([
      desktopMirrorUrl("v0.6.30", "Scient-0.6.30-x64.exe"),
    ]);
    expect(windows).toContain('releaseName: "Scient v0.6.30"');
    expect(windows).toContain('releaseNotes: "<p>Notes for 0.6.30 &amp; more</p>"');

    // C1: versioned objects are immutable for a year; channel metadata is never stored.
    expect(objects.get("scient-desktop/v0.6.30/Scient-0.6.30-x64.exe")?.httpMetadata).toMatchObject(
      { cacheControl: "public, max-age=31536000, immutable" },
    );
    expect(objects.get(`${FEED}latest-mac.yml`)?.httpMetadata).toMatchObject({
      cacheControl: "no-store",
      contentType: "text/yaml; charset=utf-8",
    });
    expect(objects.get(`${FEED}latest-mac.yml`)?.customMetadata).toEqual({
      tag: "v0.6.30",
      version: "0.6.30",
      sourceSha256: (stable.handoff.assets as { name: string; sha256: string }[]).find(
        (asset) => asset.name === "latest-mac.yml",
      )!.sha256,
    });
  });

  it("only reads the handoff while the feed already offers GitHub's release", async () => {
    const stable = await release("0.6.30");
    const { bucket, writes } = memoryBucket();
    vi.stubGlobal(
      "fetch",
      github(() => [stable]),
    );
    await syncUpdateFeed(bucket, "stable");
    const writesBefore = writes.length;
    const fetchMock = github(() => [stable]);
    vi.stubGlobal("fetch", fetchMock);

    await expect(syncUpdateFeed(bucket, "stable")).resolves.toEqual({
      channel: "stable",
      tag: "v0.6.30",
      copied: [],
      promoted: [],
      superseded: [],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(writes).toHaveLength(writesBefore);
  });

  it("moves to a new release and keeps every object of the previous one", async () => {
    const older = await release("0.6.30");
    const newer = await release("0.6.31");
    let releases = [older];
    const { bucket, objects } = memoryBucket();
    vi.stubGlobal(
      "fetch",
      github(() => releases),
    );
    await syncUpdateFeed(bucket, "stable");
    releases = [older, newer];

    await expect(syncUpdateFeed(bucket, "stable")).resolves.toMatchObject({
      tag: "v0.6.31",
      promoted: ["latest-linux.yml", "latest-mac.yml", "latest.yml"],
    });
    expect(feedFile(objects, `${FEED}latest.yml`)).toContain("../../v0.6.31/Scient-0.6.31-x64.exe");
    // The updater finds the old blockmap by substituting the old version into the new path.
    expect(objects.has("scient-desktop/v0.6.30/Scient-0.6.30-x64.exe.blockmap")).toBe(true);
    expect(objects.has("scient-desktop/v0.6.30/Scient-0.6.30-arm64.zip")).toBe(true);
  });

  it("publishes an offered extra-architecture Linux feed including its deb package", async () => {
    const stable = await release("0.6.30", "stable", { extraLinux: true });
    const { bucket, objects } = memoryBucket();
    vi.stubGlobal(
      "fetch",
      github(() => [stable]),
    );

    const result = await syncUpdateFeed(bucket, "stable");
    expect(result.promoted).toContain("latest-linux-arm64.yml");
    expect(result.copied).toContain("scient_0.6.30_arm64.deb");
    expect(objects.get("scient-desktop/v0.6.30/scient_0.6.30_arm64.deb")?.body).toBe(
      stable.files.get("scient_0.6.30_arm64.deb"),
    );
    const manifest = feedFile(objects, `${FEED}latest-linux-arm64.yml`);
    expect(manifest).toContain("../../v0.6.30/scient_0.6.30_arm64.deb");
    expect(manifest).toContain("../../v0.6.30/Scient-0.6.30-arm64.AppImage");
  });
  it("refuses bytes the handoff accepts but the release's manifest does not", async () => {
    const stable = await release("0.6.30", "stable", { sha512Of: "Scient-0.6.30-x64.exe" });
    const { bucket, objects } = memoryBucket();
    vi.stubGlobal(
      "fetch",
      github(() => [stable]),
    );

    await expect(syncUpdateFeed(bucket, "stable")).rejects.toThrow(/SHA-512/);
    expect(objects.has("scient-desktop/v0.6.30/Scient-0.6.30-x64.exe")).toBe(false);
    expect([...objects.keys()].some((key) => key.startsWith(FEED))).toBe(false);
  });

  it.each([false, true])(
    "checks an existing installer's SHA-512 before promotion (mismatch: %s)",
    async (mismatch) => {
      const name = "Scient-0.6.30-x64.exe";
      const stable = await release("0.6.30", "stable", mismatch ? { sha512Of: name } : {});
      const { bucket, objects } = memoryBucket();
      const body = stable.files.get(name)!;
      objects.set(`scient-desktop/v0.6.30/${name}`, {
        body,
        etag: "installer-already-mirrored",
        customMetadata: { sha256: await sha256(body) },
      });
      vi.stubGlobal(
        "fetch",
        github(() => [stable]),
      );

      if (mismatch) {
        await expect(syncUpdateFeed(bucket, "stable")).rejects.toThrow(/SHA-512/);
        expect([...objects.keys()].some((key) => key.startsWith(FEED))).toBe(false);
      } else {
        await expect(syncUpdateFeed(bucket, "stable")).resolves.toMatchObject({
          promoted: ["latest-linux.yml", "latest-mac.yml", "latest.yml"],
        });
      }
    },
  );

  it("refuses a macOS manifest without both architectures' updater ZIPs", async () => {
    const stable = await release("0.6.30", "stable", {
      omitPayload: "Scient-0.6.30-arm64.zip",
    });
    const { bucket, objects } = memoryBucket();
    vi.stubGlobal(
      "fetch",
      github(() => [stable]),
    );

    await expect(syncUpdateFeed(bucket, "stable")).rejects.toThrow(
      /does not reference required Scient-0.6.30-arm64\.zip/,
    );
    expect(objects.size).toBe(0);
  });

  it("refuses a ZIP without its required differential blockmap", async () => {
    const stable = await release("0.6.30", "stable", {
      omitBlockmap: "Scient-0.6.30-arm64.zip",
    });
    const { bucket, objects } = memoryBucket();
    vi.stubGlobal(
      "fetch",
      github(() => [stable]),
    );

    await expect(syncUpdateFeed(bucket, "stable")).rejects.toThrow(/no required .*\.zip\.blockmap/);
    expect(objects.size).toBe(0);
  });

  it.each([
    { channel: "stable" as const, older: "0.6.30", newer: "0.6.31" },
    {
      channel: "beta" as const,
      older: "0.6.31-beta.20261116.2",
      newer: "0.6.31-beta.20261116.10",
    },
  ])(
    "refuses a stale source after a newer $channel promotion",
    async ({ channel, older, newer }) => {
      const oldRelease = await release(older, channel);
      const newRelease = await release(newer, channel);
      let releases = [newRelease];
      const { bucket, objects, writes } = memoryBucket();
      vi.stubGlobal(
        "fetch",
        github(() => releases),
      );
      await syncUpdateFeed(bucket, channel);
      const before = new Map(objects);
      const written = writes.length;
      releases = [oldRelease];

      await expect(syncUpdateFeed(bucket, channel)).rejects.toThrow(/Refusing to regress/);
      expect(objects).toEqual(before);
      expect(writes).toHaveLength(written);
    },
  );

  it("refuses a manifest that differs from the handoff", async () => {
    const stable = await release("0.6.30");
    const { bucket, objects } = memoryBucket();
    vi.stubGlobal(
      "fetch",
      github(() => [stable], {
        "https://github.com/ScientFactory/scient-desktop/releases/download/v0.6.30/latest.yml":
          () => new Response(stable.files.get("latest.yml")!.replace("0.6.30", "0.6.29")),
      }),
    );

    await expect(syncUpdateFeed(bucket, "stable")).rejects.toThrow(
      /does not match the release handoff/,
    );
    expect(objects.size).toBe(0);
  });

  it("keeps a newer promotion when an older, slower run finishes later", async () => {
    const older = await release("0.6.30");
    const newer = await release("0.6.31");
    let releases = [older];
    let releaseSlowCopy!: () => void;
    const slowCopy = new Promise<void>((resolve) => {
      releaseSlowCopy = resolve;
    });
    const { bucket, objects } = memoryBucket();
    const exe = older.files.get("Scient-0.6.30-x64.exe")!;
    vi.stubGlobal(
      "fetch",
      github(() => releases, {
        "https://github.com/ScientFactory/scient-desktop/releases/download/v0.6.30/Scient-0.6.30-x64.exe":
          async () => {
            await slowCopy;
            return new Response(exe, { headers: { "Content-Length": String(exe.length) } });
          },
      }),
    );

    const olderRun = syncUpdateFeed(bucket, "stable");
    await vi.waitFor(() =>
      expect(objects.has("scient-desktop/v0.6.30/Scient-0.6.30-x64.dmg")).toBe(true),
    );
    releases = [older, newer];
    await expect(syncUpdateFeed(bucket, "stable")).resolves.toMatchObject({ tag: "v0.6.31" });
    releaseSlowCopy();

    await expect(olderRun).resolves.toMatchObject({
      tag: "v0.6.30",
      promoted: [],
      superseded: ["latest-linux.yml", "latest-mac.yml", "latest.yml"],
    });
    expect(feedFile(objects, `${FEED}latest.yml`)).toContain("v0.6.31");
  });

  it("publishes the newest Beta, by version, to its own feed", async () => {
    const first = await release("0.6.31-beta.20261116.1", "beta");
    const second = await release("0.6.31-beta.20261116.2", "beta");
    const stable = await release("0.6.30");
    const { bucket, objects } = memoryBucket();
    // The feed lists the newer build first, as GitHub usually does.
    vi.stubGlobal(
      "fetch",
      github(() => [stable, second, first]),
    );

    await expect(syncUpdateFeed(bucket, "beta")).resolves.toMatchObject({
      tag: "v0.6.31-beta.20261116.2",
      promoted: ["beta-linux.yml", "beta-mac.yml", "beta.yml"],
    });
    expect(feedFile(objects, "scient-desktop/updates/beta/beta.yml")).toContain(
      "  - url: ../../v0.6.31-beta.20261116.2/Scient-0.6.31-beta.20261116.2-x64.exe",
    );
    expect([...objects.keys()].some((key) => key.startsWith(FEED))).toBe(false);
  });

  it("leaves the Beta feed alone while no Beta is published", async () => {
    const stable = await release("0.6.30");
    const { bucket, writes } = memoryBucket();
    vi.stubGlobal(
      "fetch",
      github(() => [stable]),
    );

    await expect(syncUpdateFeed(bucket, "beta")).resolves.toEqual({
      channel: "beta",
      tag: null,
      copied: [],
      promoted: [],
      superseded: [],
    });
    expect(writes).toEqual([]);
  });

  it("refuses a Stable handoff on the Beta feed", async () => {
    const beta = await release("0.6.31-beta.20261116.1", "beta");
    const { bucket, writes } = memoryBucket();
    vi.stubGlobal(
      "fetch",
      github(() => [beta], {
        "https://github.com/ScientFactory/scient-desktop-beta/releases/download/v0.6.31-beta.20261116.1/scient-release-handoff.json":
          () =>
            Response.json({
              ...beta.handoff,
              distribution: { repository: "ScientFactory/scient-desktop", channel: "stable" },
            }),
      }),
    );

    await expect(syncUpdateFeed(bucket, "beta")).rejects.toThrow(/another distribution/);
    expect(writes).toEqual([]);
  });
});
