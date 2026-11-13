// FILE: mirror.ts
// Purpose: Copies the current Stable desktop installers from GitHub into ScientFactory's R2 bucket.
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
  desktopMirrorKey,
  GITHUB_RELEASE_HANDOFF_URL,
} from "../../../src/lib/release-source";

const USER_AGENT = "ScientFactory-release-mirror";
const HANDOFF_TIMEOUT_MS = 30_000;
const INSTALLER_TIMEOUT_MS = 10 * 60_000;

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

/**
 * Copies one installer unless the bucket already holds it with the handoff's digest.
 * Installer keys are immutable: bytes already published under a tag are never replaced, since
 * the current pointer and year-long caches may still serve them. A changed digest needs a new tag.
 */
async function mirrorInstaller(
  bucket: R2Bucket,
  tag: string,
  asset: ReleaseHandoffAsset,
): Promise<boolean> {
  const key = desktopMirrorKey(tag, asset.name);
  const verifyExisting = (existing: R2Object | null): false => {
    if (existing?.size === asset.size && existing.customMetadata?.sha256 === asset.sha256) {
      return false;
    }
    throw new Error(
      `${key} already holds other bytes (sha256 ${existing?.customMetadata?.sha256 ?? "unrecorded"}); ` +
        `the handoff now says ${asset.sha256}. Published installers are never replaced.`,
    );
  };
  const existing = await bucket.head(key);
  if (existing !== null) return verifyExisting(existing);

  const response = await fetch(githubReleaseDownloadUrl(tag, asset.name), {
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
  const piping = response.body.pipeTo(sized.writable, { signal: stopPiping.signal });
  let written: R2Object | null;
  try {
    written = await bucket.put(key, sized.readable, {
      onlyIf: new Headers({ "If-None-Match": "*" }),
      sha256: asset.sha256,
      httpMetadata: {
        contentType: releaseAssetContentType(asset.name),
        contentDisposition: `attachment; filename="${asset.name}"`,
        cacheControl: "public, max-age=31536000, immutable",
      },
      customMetadata: { sha256: asset.sha256 },
    });
  } catch (error) {
    stopPiping.abort();
    await piping.catch(() => undefined);
    throw error;
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
    if (await mirrorInstaller(bucket, handoff.tag, asset)) copied.push(name);
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
