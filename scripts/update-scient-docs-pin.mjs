#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { hashMarkdown, validateManifest } from "./sync-scient-docs.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultManifestPath = resolve(repositoryRoot, "docs/scient-docs-manifest.json");
const defaultSiteUrl = "https://scientfactory.com";

function githubHeaders() {
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "scient-docs-pin" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return headers;
}

async function getJson(url, headers = githubHeaders()) {
  const response = await fetch(url, { headers, redirect: "error" });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

async function getText(url) {
  const response = await fetch(url, { redirect: "error" });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.text();
}

export async function stableRelease(repository, tag) {
  // GitHub's "latest" release excludes drafts and prereleases.
  const release = await getJson(
    tag
      ? `https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`
      : `https://api.github.com/repos/${repository}/releases/latest`,
  );
  if (release.draft || release.prerelease) {
    throw new Error(`${release.tag_name} is not a published stable release`);
  }
  const commit = await getJson(
    `https://api.github.com/repos/${repository}/commits/${encodeURIComponent(release.tag_name)}`,
  );
  return { tag: release.tag_name, publishedAt: release.published_at, revision: commit.sha };
}

async function helpSourcePaths(repository, revision) {
  const entries = await getJson(
    `https://api.github.com/repos/${repository}/contents/docs/user?ref=${revision}`,
  );
  return entries
    .filter((entry) => entry.type === "file" && entry.name.endsWith(".md"))
    .map((entry) => entry.path);
}

function rawSourceLoader(repository, revision) {
  return (sourcePath) =>
    getText(`https://raw.githubusercontent.com/${repository}/${revision}/${sourcePath}`);
}

/**
 * Pins the same page selection to a release's Help. Selection changes stay a reviewed,
 * human decision, so a selected page missing at the release is reported, not dropped.
 */
export async function repinManifest({ manifest, release, loadSource, reviewedAt }) {
  validateManifest(manifest);
  const changed = [];
  const missing = [];
  const pages = [];
  for (const page of manifest.pages) {
    const markdown = await loadSource(page.sourcePath);
    if (typeof markdown !== "string") {
      missing.push(page.sourcePath);
      pages.push(page);
      continue;
    }
    const sha256 = hashMarkdown(markdown);
    if (sha256 !== page.sha256) changed.push(page.sourcePath);
    pages.push({ ...page, sha256 });
  }
  const label = release.tag.replace(/^v/, "");
  const next = {
    ...manifest,
    source: { ...manifest.source, revision: release.revision, reviewedAt },
    version: {
      ...manifest.version,
      label: `Scient v${label}`,
      appliesTo: `Scient Desktop v${label}`,
      stableReleaseTags: [release.tag],
    },
    pages,
  };
  return { manifest: validateManifest(next), changed, missing };
}

/**
 * Compares the Help the live site serves with the Help of the newest stable release,
 * page by page, so a stale label alone with identical content does not count as lag.
 */
export async function liveLag({ index, release, loadReleaseSource, loadLiveRaw, now }) {
  const comparisons = await Promise.all(
    index.pages.map(async (page) => {
      const [live, current] = await Promise.all([
        loadLiveRaw(page.slug),
        loadReleaseSource(page.sourcePath),
      ]);
      const same =
        live !== null && current !== null && hashMarkdown(live) === hashMarkdown(current);
      return same ? null : page.sourcePath;
    }),
  );
  const stalePages = comparisons.filter((path) => path !== null);
  const lagHours = (now - Date.parse(release.publishedAt)) / 3_600_000;
  const maximumLagHours = index.publication.maximumLagHours;
  return {
    liveRevision: index.source.revision,
    liveLabel: index.version.label,
    stalePages,
    lagHours,
    maximumLagHours,
    overdue: stalePages.length > 0 && lagHours > maximumLagHours,
  };
}

function pullRequestBody({ release, changed, unselected }) {
  const lines = [
    "## Why",
    "",
    `Scient Desktop ${release.tag} is the newest stable release. This moves the public Help pin to that release's exact Help source, as \`docs/architecture/scient-docs-publishing.md\` requires.`,
    "",
    "## Change",
    "",
    `- Source revision: \`${release.revision}\` (tag \`${release.tag}\`).`,
    `- Pages whose text changed (${changed.length}): ${changed.length ? changed.map((path) => `\`${path}\``).join(", ") : "none; only the version label moves"}.`,
    "- The page selection, titles, summaries and topics are unchanged.",
    "",
    `Help pages at this release that the site does not publish (${unselected.length}). Adding one is a separate reviewed decision: ${unselected.length ? unselected.map((path) => `\`${path}\``).join(", ") : "none"}.`,
    "",
    "## Verification",
    "",
    "Website CI rebuilds every selected page from the pinned revision and checks each SHA-256.",
    "",
    "## Documentation Impact",
    "",
    `Documentation impact: Updated — docs/scient-docs-manifest.json (stable Help from ${release.tag} at ${release.revision})`,
    "",
    "Opened automatically by the Scient Help release workflow; it merges only after review.",
  ];
  return `${lines.join("\n")}\n`;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index];
    if (!["--tag", "--body", "--site"].includes(key)) throw new Error(`Unknown option ${key}`);
    const value = rest[++index];
    if (!value) throw new Error(`${key} needs a value`);
    options[key.slice(2)] = value;
  }
  if (command !== "repin" && command !== "check-live") {
    throw new Error(
      "Usage: update-scient-docs-pin.mjs repin [--tag vX] [--body file] | check-live",
    );
  }
  return { command, ...options };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(readFileSync(defaultManifestPath, "utf8"));
  const repository = manifest.source.repository;
  const release = await stableRelease(repository, args.tag);

  if (args.command === "check-live") {
    const siteUrl = args.site ?? defaultSiteUrl;
    const result = await liveLag({
      index: await getJson(`${siteUrl}/docs/index.json`, { Accept: "application/json" }),
      release,
      loadReleaseSource: rawSourceLoader(repository, release.revision),
      loadLiveRaw: (slug) => getText(`${siteUrl}/docs/raw/${slug}.md`),
      now: Date.now(),
    });
    const hours = result.lagHours.toFixed(1);
    if (result.stalePages.length === 0) {
      process.stdout.write(`Live Help matches ${release.tag} (${result.liveLabel}).\n`);
    } else {
      process.stdout.write(
        `Live Help (${result.liveLabel}) differs from ${release.tag}, released ${hours} h ago, in ${result.stalePages.length} pages: ${result.stalePages.join(", ")}\n`,
      );
    }
    if (result.overdue) {
      process.stderr.write(
        `Public Help is more than ${result.maximumLagHours} h behind ${release.tag}. Merge its Help pin PR.\n`,
      );
      process.exitCode = 1;
    }
    return;
  }

  if (manifest.version.stableReleaseTags.includes(release.tag)) {
    process.stdout.write(`Help already pinned to ${release.tag}.\n`);
    return;
  }
  const result = await repinManifest({
    manifest,
    release,
    loadSource: rawSourceLoader(repository, release.revision),
    reviewedAt: new Date().toISOString().slice(0, 10),
  });
  if (result.missing.length > 0) {
    throw new Error(
      `${release.tag} no longer has selected Help pages: ${result.missing.join(", ")}. Update the selection by hand.`,
    );
  }
  writeFileSync(defaultManifestPath, `${JSON.stringify(result.manifest, null, 2)}\n`, "utf8");
  const selected = new Set(result.manifest.pages.map((page) => page.sourcePath));
  const unselected = (await helpSourcePaths(repository, release.revision)).filter(
    (path) => !selected.has(path),
  );
  if (args.body) {
    writeFileSync(args.body, pullRequestBody({ release, changed: result.changed, unselected }));
  }
  process.stdout.write(
    `Pinned Help to ${release.tag} (${release.revision}); ${result.changed.length} pages changed.\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
