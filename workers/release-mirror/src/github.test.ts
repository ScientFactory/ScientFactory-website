import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchFromGitHub } from "./github";

afterEach(() => {
  vi.unstubAllGlobals();
});

function answers(...statuses: Array<number | [number, Record<string, string>]>) {
  const fetchMock = vi.fn<typeof fetch>();
  for (const status of statuses) {
    const [code, headers] = Array.isArray(status) ? status : [status, {}];
    fetchMock.mockResolvedValueOnce(
      new Response(code === 200 ? "ok" : null, { status: code, headers }),
    );
  }
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("fetchFromGitHub", () => {
  it("waits as long as GitHub asks, then tries again", async () => {
    const fetchMock = answers([429, { "Retry-After": "2" }], 200);
    const sleep = vi.fn(async () => undefined);

    const response = await fetchFromGitHub("https://github.com/x", {}, 1_000, sleep);

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2_000);
  });

  it("caps a long Retry-After and backs off when GitHub gives none", async () => {
    answers([503, { "Retry-After": "600" }], 502, 200);
    const sleep = vi.fn(async () => undefined);

    await fetchFromGitHub("https://github.com/x", {}, 1_000, sleep);

    expect(sleep.mock.calls).toEqual([[30_000], [10_000]]);
  });

  it("returns the third refusal for the caller to report", async () => {
    const fetchMock = answers(429, 429, 429);

    const response = await fetchFromGitHub(
      "https://github.com/x",
      {},
      1_000,
      async () => undefined,
    );

    expect(response.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry an answer that will not change", async () => {
    const fetchMock = answers(404);

    const response = await fetchFromGitHub(
      "https://github.com/x",
      {},
      1_000,
      async () => undefined,
    );

    expect(response.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
