#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultManifestPath = resolve(repositoryRoot, "docs/scient-docs-manifest.json");
const defaultOutputRoot = resolve(repositoryRoot, "src/generated/scient-docs");
const dangerousMarkdown = /<(script|iframe|object|embed|style)\b|\bon[a-z]+\s*=|javascript\s*:/i;

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

export function validateManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Scient Docs manifest must be an object");
  }
  if (value.schemaVersion !== 1) throw new Error("Unsupported Scient Docs manifest schema");
  if (value.channel !== "preview" && value.channel !== "stable") {
    throw new Error("Scient Docs channel must be preview or stable");
  }
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(
      requiredString(value.source?.repository, "source.repository"),
    )
  ) {
    throw new Error("source.repository must be a GitHub owner/repository pair");
  }
  if (!/^[0-9a-f]{40}$/.test(requiredString(value.source?.revision, "source.revision"))) {
    throw new Error("source.revision must be a full 40-character Git SHA");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(requiredString(value.source?.reviewedAt, "source.reviewedAt"))) {
    throw new Error("source.reviewedAt must be an ISO date");
  }
  requiredString(value.version?.label, "version.label");
  requiredString(value.version?.appliesTo, "version.appliesTo");
  if (!Array.isArray(value.version?.stableReleaseTags)) {
    throw new Error("version.stableReleaseTags must be an array");
  }
  if (value.channel === "stable" && value.version.stableReleaseTags.length === 0) {
    throw new Error("Stable Scient Docs require at least one stable release tag");
  }
  for (const [index, tag] of value.version.stableReleaseTags.entries()) {
    requiredString(tag, `version.stableReleaseTags[${index}]`);
  }
  if (
    !Number.isInteger(value.publication?.maximumLagHours) ||
    value.publication.maximumLagHours < 1
  ) {
    throw new Error("publication.maximumLagHours must be a positive integer");
  }
  for (const key of ["releaseTrigger", "correctionTrigger", "failureMode", "rollback"]) {
    requiredString(value.publication?.[key], `publication.${key}`);
  }
  if (!Array.isArray(value.pages) || value.pages.length === 0) {
    throw new Error("Scient Docs manifest must select at least one page");
  }

  const slugs = new Set();
  const sourcePaths = new Set();
  for (const [index, page] of value.pages.entries()) {
    const prefix = `pages[${index}]`;
    const slug = requiredString(page.slug, `${prefix}.slug`);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
      throw new Error(`${prefix}.slug must be a lowercase URL slug`);
    }
    if (slugs.has(slug)) throw new Error(`Duplicate Scient Docs slug: ${slug}`);
    slugs.add(slug);
    const sourcePath = requiredString(page.sourcePath, `${prefix}.sourcePath`);
    if (
      !sourcePath.startsWith("docs/user/") ||
      !sourcePath.endsWith(".md") ||
      sourcePath.includes("\\") ||
      posix.normalize(sourcePath) !== sourcePath
    ) {
      throw new Error(`${prefix}.sourcePath must be a docs/user Markdown path`);
    }
    if (sourcePaths.has(sourcePath)) throw new Error(`Duplicate Help source path: ${sourcePath}`);
    sourcePaths.add(sourcePath);
    requiredString(page.title, `${prefix}.title`);
    requiredString(page.summary, `${prefix}.summary`);
    requiredString(page.topic, `${prefix}.topic`);
    if (page.secondary !== undefined && typeof page.secondary !== "boolean") {
      throw new Error(`${prefix}.secondary must be a boolean when provided`);
    }
    if (!/^[0-9a-f]{64}$/.test(requiredString(page.sha256, `${prefix}.sha256`))) {
      throw new Error(`${prefix}.sha256 must be a SHA-256 digest`);
    }
  }
  return value;
}

export function hashMarkdown(markdown) {
  return createHash("sha256").update(markdown, "utf8").digest("hex");
}

function sourceWebUrl(manifest, sourcePath) {
  return `https://github.com/${manifest.source.repository}/blob/${manifest.source.revision}/${sourcePath}`;
}

export function rewriteHelpLinks(markdown, page, manifest) {
  const selectedByPath = new Map(
    manifest.pages.map((candidate) => [candidate.sourcePath, candidate]),
  );
  return markdown.replace(/(\]\()([^)]+)(\))/g, (whole, open, rawTarget, close) => {
    const target = rawTarget.trim();
    if (target.startsWith("#") || target.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(target)) {
      return whole;
    }
    const hashIndex = target.indexOf("#");
    const targetPath = hashIndex === -1 ? target : target.slice(0, hashIndex);
    const fragment = hashIndex === -1 ? "" : target.slice(hashIndex);
    if (!targetPath.endsWith(".md")) return whole;
    const normalized = posix.normalize(posix.join(posix.dirname(page.sourcePath), targetPath));
    const selected = selectedByPath.get(normalized);
    const rewritten = selected
      ? `/docs/${selected.slug}/${fragment}`
      : `${sourceWebUrl(manifest, normalized)}${fragment}`;
    return `${open}${rewritten}${close}`;
  });
}

function searchableText(markdown) {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_|~-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function frontmatter(page, manifest) {
  const values = {
    title: page.title,
    summary: page.summary,
    topic: page.topic,
    slug: page.slug,
    sourcePath: page.sourcePath,
    sourceRevision: manifest.source.revision,
    channel: manifest.channel,
    versionLabel: manifest.version.label,
    appliesTo: manifest.version.appliesTo,
  };
  return [
    "---",
    ...Object.entries(values).map(([key, value]) => `${key}: ${JSON.stringify(value)}`),
    "---",
    "",
  ].join("\n");
}

export async function generateDocs({ manifest, loadSource, outputRoot = defaultOutputRoot }) {
  validateManifest(manifest);
  const rawBySlug = {};
  const pages = [];

  for (const page of manifest.pages) {
    const markdown = await loadSource(page.sourcePath);
    if (typeof markdown !== "string")
      throw new Error(`Source loader returned no text for ${page.sourcePath}`);
    const actualHash = hashMarkdown(markdown);
    if (actualHash !== page.sha256) {
      throw new Error(
        `${page.sourcePath} SHA-256 mismatch: expected ${page.sha256}, received ${actualHash}`,
      );
    }
    if (dangerousMarkdown.test(markdown)) {
      throw new Error(`${page.sourcePath} contains executable or unsafe raw Markdown content`);
    }
    if (!/^#\s+\S.+$/m.test(markdown)) {
      throw new Error(`${page.sourcePath} must contain an H1 heading`);
    }

    rawBySlug[page.slug] = markdown;
    pages.push({
      ...page,
      channel: manifest.channel,
      versionLabel: manifest.version.label,
      appliesTo: manifest.version.appliesTo,
      sourceRepository: manifest.source.repository,
      sourceRevision: manifest.source.revision,
      sourceUrl: sourceWebUrl(manifest, page.sourcePath),
      rawUrl: `/docs/raw/${page.slug}.md`,
      url: `/docs/${page.slug}/`,
      searchText: searchableText(markdown),
    });
  }

  rmSync(outputRoot, { recursive: true, force: true });
  const pagesRoot = resolve(outputRoot, "pages");
  mkdirSync(pagesRoot, { recursive: true });
  for (const page of manifest.pages) {
    const rendered = rewriteHelpLinks(rawBySlug[page.slug], page, manifest);
    writeFileSync(
      resolve(pagesRoot, `${page.slug}.md`),
      `${frontmatter(page, manifest)}${rendered}`,
      "utf8",
    );
  }

  const index = {
    schemaVersion: 1,
    channel: manifest.channel,
    source: manifest.source,
    version: manifest.version,
    corpusDefaults: manifest.corpusDefaults,
    publication: manifest.publication,
    pages,
  };
  writeFileSync(resolve(outputRoot, "index.json"), `${JSON.stringify(index, null, 2)}\n`, "utf8");
  writeFileSync(resolve(outputRoot, "raw.json"), `${JSON.stringify(rawBySlug, null, 2)}\n`, "utf8");
  return index;
}

function localSourceLoader(sourceRoot, expectedRevision) {
  const root = realpathSync(sourceRoot);
  const actualRevision = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  if (actualRevision !== expectedRevision) {
    throw new Error(
      `SCIENT_DOCS_SOURCE_ROOT is at ${actualRevision}, expected ${expectedRevision}`,
    );
  }
  return async (sourcePath) => readFileSync(resolve(root, sourcePath), "utf8");
}

function remoteSourceLoader(manifest) {
  return async (sourcePath) => {
    const url = `https://raw.githubusercontent.com/${manifest.source.repository}/${manifest.source.revision}/${sourcePath}`;
    const response = await fetch(url, { redirect: "error" });
    if (!response.ok) throw new Error(`Could not fetch ${sourcePath}: HTTP ${response.status}`);
    return response.text();
  };
}

export async function syncFromManifest({
  manifestPath = defaultManifestPath,
  outputRoot = defaultOutputRoot,
  sourceRoot = process.env.SCIENT_DOCS_SOURCE_ROOT,
} = {}) {
  const manifest = validateManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
  const loadSource = sourceRoot
    ? localSourceLoader(sourceRoot, manifest.source.revision)
    : remoteSourceLoader(manifest);
  const index = await generateDocs({ manifest, loadSource, outputRoot });
  return { outputRoot, pageCount: index.pages.length, revision: manifest.source.revision };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await syncFromManifest();
    process.stdout.write(
      `Synced ${result.pageCount} Scient Docs pages from ${result.revision} into ${result.outputRoot}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
