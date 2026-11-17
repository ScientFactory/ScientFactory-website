/** Bounded transport shared by ingestion and PostHog erasure. */
export class TransportFailure extends Error {
  constructor(readonly kind: "body-too-large" | "invalid-json" | "network" | "timeout" | "http") {
    super(kind);
  }
}

export async function readBoundedJson(
  message: Request | Response,
  maximumBytes: number,
): Promise<unknown> {
  const declaredLength = Number(message.headers.get("Content-Length") ?? 0);
  if (declaredLength > maximumBytes) throw new TransportFailure("body-too-large");
  const reader = message.body?.getReader();
  if (!reader) throw new TransportFailure("invalid-json");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximumBytes) throw new TransportFailure("body-too-large");
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch {
      throw new TransportFailure("invalid-json");
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Never follow redirects with the PostHog deletion credential. */
export async function posthogRequest(url: string, init: RequestInit): Promise<Response> {
  try {
    const response = await fetch(url, {
      ...init,
      // A manual redirect response is never followed, so credentials remain
      // scoped to the configured PostHog origin. Cloudflare's runtime rejects
      // `redirect: "error"` as a failed subrequest before a response is
      // available, which prevents otherwise valid requests.
      redirect: "manual",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new TransportFailure("http");
    }
    return response;
  } catch (error) {
    if (error instanceof TransportFailure) throw error;
    throw new TransportFailure(
      error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network",
    );
  }
}
