import { describe, expect, it, vi } from "vitest";
import { createPosthogApi } from "./posthog-api.mjs";

describe("operator PostHog API", () => {
  it("restricts pagination and credentials to the configured project", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ results: [] }));
    const api = createPosthogApi({ apiKey: "synthetic", projectId: "123", fetchImpl });
    for (const path of [
      "https://elsewhere.invalid/api/projects/123/",
      "https://eu.posthog.com/api/projects/456/",
      "//elsewhere.invalid/",
      "../456/",
    ]) {
      await expect(api(path)).rejects.toThrow("outside the configured project");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await api("insights/?limit=100")).toEqual({ results: [] });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://eu.posthog.com/api/projects/123/insights/?limit=100",
      expect.objectContaining({
        redirect: "error",
        signal: expect.any(AbortSignal),
        headers: { Authorization: "Bearer synthetic" },
      }),
    );
  });
  it("does not leak error bodies or retry ambiguous creates", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("private upstream detail", { status: 503 }));
    const api = createPosthogApi({ apiKey: "synthetic", projectId: "123", fetchImpl });
    await expect(api("dashboards/", { method: "POST", body: "{}" })).rejects.toThrow(
      "PostHog API request failed (503)",
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it("bounds streamed responses and cancels oversized bodies", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
      },
      cancel,
    });
    const api = createPosthogApi({
      apiKey: "synthetic",
      projectId: "123",
      fetchImpl: async () => new Response(body),
    });
    await expect(api("query/", { method: "POST" })).rejects.toThrow("exceeded limit");
    expect(cancel).toHaveBeenCalledOnce();
  });
});
