// FILE: github.ts
// Purpose: Fetches from github.com for the release mirror, retrying GitHub's brief refusals.
// Layer: Cloudflare Worker

/** Statuses GitHub uses for a refusal or outage that usually clears within seconds. */
const RETRYABLE = new Set([429, 502, 503, 504]);
const ATTEMPTS = 3;
const MAX_RETRY_AFTER_MS = 30_000;

/** How long GitHub asked us to wait, or a short growing pause when it did not say. */
function retryDelay(response: Response, attempt: number): number {
  const header = response.headers.get("Retry-After");
  const seconds = header === null ? Number.NaN : Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }
  return 5_000 * attempt;
}

/**
 * `fetch` that tries again, up to three attempts in all, when GitHub answers 429 or a gateway
 * error. Each attempt gets its own timeout. Any other answer, including the last refusal, is
 * returned for the caller to judge.
 */
export async function fetchFromGitHub(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<Response> {
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!RETRYABLE.has(response.status) || attempt >= ATTEMPTS) return response;
    await response.body?.cancel();
    await sleep(retryDelay(response, attempt));
  }
}
