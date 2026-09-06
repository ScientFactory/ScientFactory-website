/** Bounded transport shared by ingestion and the optional analysis exporter. */
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

/** Never follow redirects with an analysis project token or deletion credential. */
export async function posthogRequest(url: string, init: RequestInit): Promise<Response> {
  try {
    const response = await fetch(url, {
      ...init,
      redirect: "error",
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

/** Stable UUIDv8 for event IDs that can also come from legacy website writers. */
export async function posthogEventUuid(id: string): Promise<string> {
  const hash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`scient:analytics:event:${id}`)),
  );
  hash[6] = (hash[6]! & 0x0f) | 0x80;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = [...hash.subarray(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
