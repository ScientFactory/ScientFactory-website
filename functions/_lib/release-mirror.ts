// FILE: release-mirror.ts
// Purpose: Reads and writes the Stable pointer of ScientFactory's own copy of the desktop installers.
// Layer: Cloudflare utility shared by the Pages download path and the release mirror worker

import { parseReleaseHandoff, type ReleaseHandoff } from "../../src/lib/release-handoff";
import { DESKTOP_MIRROR_STABLE_KEY } from "../../src/lib/release-source";

const MAX_POINTER_BYTES = 128 * 1024;

/**
 * The Stable pointer. The mirror worker writes it only after every installer of `handoff`
 * is in the bucket with R2-verified SHA-256, so a pointer always names complete bytes.
 */
export interface DesktopMirrorPointer {
  readonly schemaVersion: 1;
  /** The handoff exactly as GitHub served it, revalidated on every read. */
  readonly handoff: unknown;
  /** GitHub's Last-Modified for the handoff, the closest thing to a publish time. */
  readonly publishedAt: string | null;
  /** When the installers of this handoff finished copying. */
  readonly mirroredAt: string;
  /** When the worker last confirmed this handoff is still GitHub's latest. */
  readonly checkedAt: string;
}

export interface MirroredRelease {
  readonly pointer: DesktopMirrorPointer;
  readonly handoff: ReleaseHandoff;
  readonly checkedAtMs: number;
}

function timestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseMirrorPointer(value: unknown): MirroredRelease {
  if (typeof value !== "object" || value === null) {
    throw new Error("Mirror pointer is not an object.");
  }
  const pointer = value as Partial<DesktopMirrorPointer>;
  const checkedAtMs = timestamp(pointer.checkedAt);
  if (
    pointer.schemaVersion !== 1 ||
    (pointer.publishedAt !== null && typeof pointer.publishedAt !== "string") ||
    timestamp(pointer.mirroredAt) === null ||
    checkedAtMs === null
  ) {
    throw new Error("Mirror pointer is invalid.");
  }
  return {
    pointer: pointer as DesktopMirrorPointer,
    handoff: parseReleaseHandoff(pointer.handoff),
    checkedAtMs,
  };
}

/** The current Stable pointer, null when nothing has been mirrored yet. Throws when unreadable. */
export async function readMirroredRelease(bucket: R2Bucket): Promise<MirroredRelease | null> {
  const object = await bucket.get(DESKTOP_MIRROR_STABLE_KEY);
  if (object === null) return null;
  if (object.size > MAX_POINTER_BYTES) throw new Error("Mirror pointer is too large.");
  return parseMirrorPointer(JSON.parse(await object.text()) as unknown);
}

/**
 * Writes the pointer only if it is still the version this run observed (`observedEtag`, or
 * absent when null). Returns false when another run wrote it first, so a slow run that saw an
 * older release can never replace a newer promotion.
 */
export async function writeMirrorPointer(
  bucket: R2Bucket,
  pointer: DesktopMirrorPointer,
  observedEtag: string | null,
): Promise<boolean> {
  const written = await bucket.put(DESKTOP_MIRROR_STABLE_KEY, JSON.stringify(pointer), {
    onlyIf:
      observedEtag === null ? new Headers({ "If-None-Match": "*" }) : { etagMatches: observedEtag },
    httpMetadata: {
      contentType: "application/json; charset=utf-8",
      cacheControl: "no-store",
    },
  });
  return written !== null;
}
