// FILE: mirror.ts
// Purpose: Copies the current Stable desktop installers from GitHub into ScientFactory's R2 bucket,
//          and provides the verified, immutable asset copy the update feeds share.
// Layer: Cloudflare Worker (scheduled)

import { readHandoff } from "../../../functions/_lib/latest-release";
import { readMirroredRelease, writeMirrorPointer } from "../../../functions/_lib/release-mirror";
import {
  githubReleaseDownloadUrl,
  parseReleaseHandoff,
  releaseAssetContentType,
  requiredInstallerNames,
  type ReleaseHandoffAsset,
} from "../../../src/lib/release-handoff";
import {
  DESKTOP_MIRROR_STABLE_KEY,
  DESKTOP_RELEASE_REPOSITORY,
  desktopMirrorKey,
  GITHUB_RELEASE_HANDOFF_URL,
} from "../../../src/lib/release-source";

export const USER_AGENT = "ScientFactory-release-mirror";
const HANDOFF_TIMEOUT_MS = 30_000;
const INSTALLER_TIMEOUT_MS = 10 * 60_000;
/** Versioned objects never change, so browsers and the edge may keep them for a year. */
export const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";

export interface MirrorSyncResult {
  readonly tag: string;
  /** Installers copied this run; empty when the bucket already held every verified copy. */
  readonly copied: readonly string[];
  /** True when this run moved the Stable pointer to a different release. */
  readonly promoted: boolean;
  /** True when another run wrote the pointer first, so this run left it alone. */
  readonly superseded: boolean;
}

async function fetchLatestHandoff(): Promise<{ raw: unknown; publishedAt: string | null }> {
  const response = await fetch(GITHUB_RELEASE_HANDOFF_URL, {
    headers: { Accept: "application/octet-stream, application/json", "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(HANDOFF_TIMEOUT_MS),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`GitHub returned ${response.status} for the release handoff.`);
  }
  const raw = await readHandoff(response);
  const lastModified = Date.parse(response.headers.get("Last-Modified") ?? "");
  return {
    raw,
    publishedAt: Number.isFinite(lastModified) ? new Date(lastModified).toISOString() : null,
  };
}

/** What the mirror needs to copy one published release asset. */
export interface ReleaseAssetSource {
  /** The GitHub repository whose release holds the asset. */
  readonly repository: string;
  readonly tag: string;
  readonly asset: ReleaseHandoffAsset;
  /**
   * The base64 SHA-512 the release's electron-updater manifest records for these bytes. When
   * set, the copy is refused unless the streamed bytes hash to it as well as to the handoff's
   * SHA-256.
   */
  readonly sha512?: string;
}

function base64(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Passes bytes through while hashing them, holding back the last chunk until the SHA-512 is
 * known. A mismatch errors the stream before the final bytes reach R2, so a fixed-length
 * upload can never complete with them.
 */
function verifySha512(expected: string, name: string): TransformStream<Uint8Array, Uint8Array> {
  const digest = new crypto.DigestStream("SHA-512");
  const hashing = digest.getWriter();
  let held: Uint8Array | null = null;
  return new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      await hashing.write(chunk);
      if (held !== null) controller.enqueue(held);
      held = chunk;
    },
    async flush(controller) {
      await hashing.close();
      const actual = base64(await digest.digest);
      if (actual !== expected) {
        throw new Error(`${name} does not match its update manifest's SHA-512.`);
      }
      if (held !== null) controller.enqueue(held);
    },
  });
}

/**
 * Copies one release asset to `scient-desktop/<tag>/<name>` unless the bucket already holds it
 * with the handoff's digest. Keys are immutable: bytes already published under a tag are never
 * replaced, since the current pointer, update feeds and year-long caches may still serve them.
 * A changed digest needs a new tag. Returns true when this call wrote the object.
 */
export async function mirrorReleaseAsset(
  bucket: R2Bucket,
  { repository, tag, asset, sha512 }: ReleaseAssetSource,
): Promise<boolean> {
  const key = desktopMirrorKey(tag, asset.name);
  const verifyExisting = async (existing: R2Object | null): Promise<false> => {
    if (existing?.size !== asset.size || existing.customMetadata?.sha256 !== asset.sha256) {
      throw new Error(
        `${key} already holds other bytes (sha256 ${existing?.customMetadata?.sha256 ?? "unrecorded"}); ` +
          `the handoff now says ${asset.sha256}. Published assets are never replaced.`,
      );
    }
    if (sha512 !== undefined && existing.customMetadata?.sha512 !== sha512) {
      const stored = await bucket.get(key);
      if (stored === null) throw new Error(`${key} disappeared before verification.`);
      const digest = new crypto.DigestStream("SHA-512");
      await stored.body.pipeTo(digest);
      if (base64(await digest.digest) !== sha512) {
        throw new Error(`${key} does not match its update manifest's SHA-512.`);
      }
    }
    return false;
  };
  const existing = await bucket.head(key);
  if (existing !== null) return verifyExisting(existing);

  const response = await fetch(githubReleaseDownloadUrl(tag, asset.name, repository), {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(INSTALLER_TIMEOUT_MS),
  });
  if (!response.ok || response.body === null) {
    await response.body?.cancel();
    throw new Error(`GitHub returned ${response.status} for ${asset.name}.`);
  }
  const declared = response.headers.get("Content-Length");
  if (declared !== null && Number(declared) !== asset.size) {
    await response.body.cancel();
    throw new Error(`${asset.name} is ${declared} bytes; the handoff says ${asset.size}.`);
  }

  // R2 needs a known length for a streamed body, and rejects the write when the bytes do not
  // hash to `sha256`. `If-None-Match: *` keeps a concurrent run from replacing the object.
  const sized = new FixedLengthStream(asset.size);
  const stopPiping = new AbortController();
  const source =
    sha512 === undefined
      ? response.body
      : response.body.pipeThrough(verifySha512(sha512, asset.name));
  const piping = source.pipeTo(sized.writable, { signal: stopPiping.signal });
  let written: R2Object | null;
  try {
    written = await bucket.put(key, sized.readable, {
      onlyIf: new Headers({ "If-None-Match": "*" }),
      sha256: asset.sha256,
      httpMetadata: {
        contentType: releaseAssetContentType(asset.name),
        contentDisposition: `attachment; filename="${asset.name}"`,
        cacheControl: IMMUTABLE_CACHE_CONTROL,
      },
      customMetadata: { sha256: asset.sha256, ...(sha512 === undefined ? {} : { sha512 }) },
    });
  } catch (error) {
    stopPiping.abort();
    // The stream's own failure (a SHA-512 mismatch, a short body) explains R2's refusal best.
    const piped = await piping.then(
      () => null,
      (cause: unknown) => cause,
    );
    throw piped instanceof Error && !(piped.name === "AbortError") ? piped : error;
  }
  if (written === null) {
    stopPiping.abort();
    await piping.catch(() => undefined);
    return verifyExisting(await bucket.head(key));
  }
  await piping;
  return true;
}

/**
 * Brings the bucket up to GitHub's latest Stable release. Installers are copied (or confirmed)
 * first; the Stable pointer is written last, so it never names bytes that are not there.
 */
export async function syncDesktopMirror(bucket: R2Bucket, now: Date): Promise<MirrorSyncResult> {
  // The pointer version this run may replace, captured before anything this run learns from
  // GitHub: a run whose GitHub answer predates another run's promotion must lose its swap.
  const observed = await bucket.head(DESKTOP_MIRROR_STABLE_KEY);
  const { raw, publishedAt } = await fetchLatestHandoff();
  const handoff = parseReleaseHandoff(raw);
  // An unreadable pointer is replaced below rather than blocking the mirror.
  const current = await readMirroredRelease(bucket).catch(() => null);

  const copied: string[] = [];
  for (const name of requiredInstallerNames(handoff.version)) {
    const asset = handoff.assets.find((candidate) => candidate.name === name);
    if (!asset) throw new Error(`Handoff ${handoff.tag} has no ${name}.`);
    const source = { repository: DESKTOP_RELEASE_REPOSITORY, tag: handoff.tag, asset };
    if (await mirrorReleaseAsset(bucket, source)) copied.push(name);
  }

  const sameRelease =
    current !== null && JSON.stringify(current.handoff) === JSON.stringify(handoff);
  const at = now.toISOString();
  const written = await writeMirrorPointer(
    bucket,
    {
      schemaVersion: 1,
      handoff: raw,
      publishedAt,
      mirroredAt: sameRelease && copied.length === 0 ? current.pointer.mirroredAt : at,
      checkedAt: at,
    },
    observed?.etag ?? null,
  );
  return {
    tag: handoff.tag,
    copied,
    promoted: written && !sameRelease,
    superseded: !written,
  };
}
