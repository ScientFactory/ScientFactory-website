// FILE: release-schema.ts
// Purpose: Validates the release metadata contract shared by the browser and edge function.
// Layer: Marketing domain utility

export interface ReleaseAsset {
  readonly name: string;
  readonly browser_download_url: string;
  readonly content_type: string;
  readonly size: number;
  readonly digest?: string | null;
}

export interface Release {
  readonly tag_name: string;
  readonly name: string | null;
  readonly html_url: string;
  readonly published_at: string;
  readonly prerelease: boolean;
  readonly assets: readonly ReleaseAsset[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isReleaseAsset(value: unknown): value is ReleaseAsset {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.browser_download_url === "string" &&
    typeof value.content_type === "string" &&
    typeof value.size === "number" &&
    (value.digest === undefined || value.digest === null || typeof value.digest === "string")
  );
}

export function parseRelease(value: unknown): Release {
  if (
    !isRecord(value) ||
    typeof value.tag_name !== "string" ||
    (value.name !== null && typeof value.name !== "string") ||
    typeof value.html_url !== "string" ||
    typeof value.published_at !== "string" ||
    typeof value.prerelease !== "boolean" ||
    !Array.isArray(value.assets) ||
    !value.assets.every(isReleaseAsset)
  ) {
    throw new Error("GitHub returned an invalid release response.");
  }

  return {
    tag_name: value.tag_name,
    name: value.name,
    html_url: value.html_url,
    published_at: value.published_at,
    prerelease: value.prerelease,
    assets: value.assets,
  };
}
