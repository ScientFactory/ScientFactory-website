// FILE: updateManifest.ts
// Purpose: Reads and re-points the electron-updater channel manifests a desktop release publishes.
// Layer: Cloudflare Worker (scheduled)

/** One downloadable file a manifest names, as electron-builder writes it. */
export interface UpdateManifestFile {
  readonly url: string;
  readonly sha512: string;
  readonly size: number;
}

export interface UpdateManifest {
  readonly version: string;
  readonly files: readonly UpdateManifestFile[];
  /** The legacy single-file field; electron-updater uses it only when `files` is empty. */
  readonly path: string | null;
  readonly hasReleaseName: boolean;
  readonly hasReleaseNotes: boolean;
}

/** What GitHub's release feed says about the release, as electron-updater's GitHub provider shows it. */
export interface UpdateManifestRelease {
  readonly name: string;
  readonly notes: string;
}

const FILE_URL = /^ {2}- url: (.+)$/u;
const FILE_FIELD = /^ {4}([A-Za-z][A-Za-z0-9]*): (.+)$/u;
const TOP_LEVEL = /^([A-Za-z][A-Za-z0-9]*):(?: (.*))?$/u;
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u;

function scalar(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/gu, "'");
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return JSON.parse(value) as string;
  }
  return value;
}

/**
 * Parses the flat subset of YAML electron-builder and the release's manifest merge write:
 * top-level scalars, and a `files` list of scalar maps. Anything else (block scalars, nested
 * maps, anchors) is refused rather than guessed at, because the feed copy is rewritten line by
 * line and must not misread a line inside a multi-line value.
 */
export function parseUpdateManifest(text: string, name: string): UpdateManifest {
  let version: string | null = null;
  let path: string | null = null;
  let hasReleaseName = false;
  let hasReleaseNotes = false;
  let inFiles = false;
  const files: UpdateManifestFile[] = [];
  let current: { url: string; sha512?: string; size?: number } | null = null;
  const finish = () => {
    if (current === null) return;
    if (current.sha512 === undefined || current.size === undefined) {
      throw new Error(`${name} has a file entry without sha512 and size.`);
    }
    files.push({ url: current.url, sha512: current.sha512, size: current.size });
    current = null;
  };

  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trimEnd();
    if (line === "") continue;
    const fileUrl = inFiles ? FILE_URL.exec(line) : null;
    if (fileUrl) {
      finish();
      current = { url: scalar(fileUrl[1]!) };
      continue;
    }
    const field = current !== null ? FILE_FIELD.exec(line) : null;
    if (field) {
      const value = scalar(field[2]!);
      if (/^[|>]/u.test(value)) throw new Error(`${name} has an unsupported block value.`);
      if (field[1] === "sha512") current!.sha512 = value;
      if (field[1] === "size") {
        if (!/^\d+$/u.test(value)) throw new Error(`${name} has an invalid file size.`);
        current!.size = Number(value);
      }
      continue;
    }
    finish();
    inFiles = false;
    const top = TOP_LEVEL.exec(line);
    if (!top) throw new Error(`${name} has an unsupported line.`);
    const [, key, rawValue = ""] = top;
    if (key === "files" && rawValue.trim() === "") {
      inFiles = true;
      continue;
    }
    const value = scalar(rawValue);
    if (value === "" || /^[|>&*!]/u.test(value)) {
      throw new Error(`${name} has an unsupported value for ${key}.`);
    }
    if (key === "version") version = value;
    if (key === "path") path = value;
    if (key === "releaseName") hasReleaseName = true;
    if (key === "releaseNotes") hasReleaseNotes = true;
  }
  finish();

  if (version === null) throw new Error(`${name} has no version.`);
  if (files.length === 0) throw new Error(`${name} names no files.`);
  const urls = new Set<string>();
  for (const file of files) {
    // A bare file name is what makes the release's relative URLs resolvable at all; an absolute
    // or nested URL would keep clients tied to another host.
    if (!ASSET_NAME.test(file.url) || urls.has(file.url)) {
      throw new Error(`${name} names an unsafe or duplicate file: ${file.url}.`);
    }
    urls.add(file.url);
  }
  if (path !== null && !urls.has(path)) {
    throw new Error(`${name} has a path that is not one of its files.`);
  }
  return { version, files, path, hasReleaseName, hasReleaseNotes };
}

/** A YAML double-quoted scalar: JSON's escapes, plus the characters YAML refuses unescaped. */
function quoted(value: string): string {
  return JSON.stringify(value).replace(
    /[\u007f-\u009f\u2028\u2029\ufeff]/gu,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/**
 * The feed copy of a release's manifest. electron-updater resolves each file URL against the
 * feed (`new URL(url, feed + "/")`), so every bare name becomes `../../<tag>/<name>`: from
 * `scient-desktop/updates/<channel>/` that is the release's immutable directory. The bytes'
 * sizes and SHA-512s are left exactly as the release recorded them. Blockmaps need no entry:
 * the updater derives `<file>.blockmap` beside the resolved file, and the previous version's
 * by substituting the version in that path, which the version directories also satisfy.
 *
 * `release` adds the name and notes GitHub's provider would have shown, unless the manifest
 * already carries its own.
 */
export function feedUpdateManifest(
  text: string,
  name: string,
  tag: string,
  release: UpdateManifestRelease | null,
): string {
  const manifest = parseUpdateManifest(text, name);
  const relative = (file: string) => `../../${tag}/${file}`;
  const lines = text
    .split(/\r?\n/u)
    .map((rawLine) => {
      const line = rawLine.trimEnd();
      const fileUrl = FILE_URL.exec(line);
      if (fileUrl) return `  - url: ${relative(scalar(fileUrl[1]!))}`;
      const top = TOP_LEVEL.exec(line);
      if (top?.[1] === "path") return `path: ${relative(scalar(top[2]!))}`;
      return line;
    })
    .filter((line, index, all) => line !== "" || index < all.length - 1);
  if (release !== null) {
    if (!manifest.hasReleaseName) lines.push(`releaseName: ${quoted(release.name)}`);
    if (!manifest.hasReleaseNotes && release.notes !== "") {
      lines.push(`releaseNotes: ${quoted(release.notes)}`);
    }
  }
  const rewritten = `${lines.join("\n")}\n`;
  // The copy must still describe exactly the same bytes.
  const check = parseUpdateManifest(
    rewritten.replaceAll(`../../${tag}/`, ""),
    `${name} (feed copy)`,
  );
  if (JSON.stringify(check.files) !== JSON.stringify(manifest.files)) {
    throw new Error(`${name} changed while being re-pointed.`);
  }
  return rewritten;
}
