const ORIGIN = "https://eu.posthog.com";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** Operator-only API transport. Never runs in the desktop app or on page visits. */
export function createPosthogApi({ apiKey, projectId, fetchImpl = fetch }) {
  if (!/^\d+$/.test(projectId)) throw new Error("Invalid PostHog project");
  const root = `${ORIGIN}/api/projects/${projectId}/`;
  return async (path, init = {}) => {
    const url = new URL(path, root);
    if (
      url.origin !== ORIGIN ||
      !url.pathname.startsWith(new URL(root).pathname) ||
      url.username ||
      url.password
    ) {
      throw new Error("PostHog API URL is outside the configured project");
    }
    // No blind retries: a timed-out create may already have succeeded.
    const response = await fetchImpl(url.href, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: {
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        Authorization: `Bearer ${apiKey}`,
      },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`PostHog API request failed (${response.status})`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("PostHog API returned no response");
    let size = 0;
    const chunks = [];
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        size += result.value.byteLength;
        if (size > MAX_RESPONSE_BYTES) throw new Error("PostHog API response exceeded limit");
        chunks.push(result.value);
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new Error("PostHog API returned invalid JSON");
    }
  };
}
