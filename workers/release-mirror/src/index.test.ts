import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
const failing = new Set<string>();

vi.mock("./mirror", () => ({
  syncDesktopMirror: vi.fn(async () => {
    calls.push("mirror");
    if (failing.has("mirror")) throw new Error("GitHub returned 429 for the release handoff.");
    return { tag: "v1.0.0", copied: [], promoted: false, superseded: false };
  }),
}));
vi.mock("./updateFeed", () => ({
  syncUpdateFeed: vi.fn(async (_bucket: unknown, channel: string) => {
    calls.push(channel);
    return { channel, tag: "v1.0.0", copied: [], promoted: [], superseded: [] };
  }),
}));

const { default: worker, runMirror } = await import("./index");

const bucket = {} as R2Bucket;
const TOKEN = "s3cret-token";

function env(token: string | undefined = TOKEN) {
  return {
    DESKTOP_DOWNLOADS: bucket,
    ...(token === undefined ? {} : { MIRROR_SYNC_TOKEN: token }),
  };
}

function sync(path: string, init: RequestInit = {}, token?: string) {
  const request = new Request(`https://mirror.example${path}`, { method: "POST", ...init });
  return worker.fetch(request as never, env(token) as never);
}

async function lines(response: Response) {
  return (await response.text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeEach(() => {
  calls.length = 0;
  failing.clear();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runMirror", () => {
  it("publishes the Stable feed before the download-page mirror, so installers are hashed once", async () => {
    await runMirror(bucket, new Date(), ["stable", "beta"], () => undefined);
    expect(calls).toEqual(["stable", "mirror", "beta"]);
  });

  it("keeps going after a failed step and counts it", async () => {
    failing.add("mirror");
    const report: Array<Record<string, unknown>> = [];

    const failures = await runMirror(bucket, new Date(), ["stable", "beta"], (line) =>
      report.push(line),
    );

    expect(failures).toBe(1);
    expect(calls).toEqual(["stable", "mirror", "beta"]);
    expect(report.map((line) => line.message)).toEqual([
      "Stable update feed synchronized",
      "Desktop mirror failed",
      "Beta update feed synchronized",
    ]);
    expect(report[1]!.error).toMatch(/429/);
  });

  it("runs only the requested channel", async () => {
    await runMirror(bucket, new Date(), ["beta"], () => undefined);
    expect(calls).toEqual(["beta"]);
  });
});

describe("scheduled run", () => {
  it("runs every channel and fails the invocation when a step failed", async () => {
    failing.add("mirror");
    const controller = {
      scheduledTime: Date.now(),
      cron: "3-59/10 * * * *",
    } as ScheduledController;

    await expect(worker.scheduled(controller, env() as never)).rejects.toThrow(
      /1 release mirror step/,
    );
    expect(calls).toEqual(["stable", "mirror", "beta"]);
  });
});

describe("POST /sync", () => {
  const auth = { headers: { Authorization: `Bearer ${TOKEN}` } };

  it("streams each step and a final summary", async () => {
    const response = await sync("/sync?channel=stable", auth);

    expect(response.status).toBe(200);
    const report = await lines(response);
    expect(report.map((line) => line.message)).toEqual([
      "Release mirror started",
      "Stable update feed synchronized",
      "Desktop mirror synchronized",
      "Release mirror finished",
    ]);
    expect(report.at(-1)).toMatchObject({ failures: 0 });
    expect(calls).toEqual(["stable", "mirror"]);
  });

  it("does not exist while no token is configured", async () => {
    const response = await sync("/sync", auth, "");
    expect(response.status).toBe(404);
    expect(calls).toEqual([]);
  });

  it("refuses a missing or wrong token", async () => {
    expect((await sync("/sync")).status).toBe(401);
    expect(
      (await sync("/sync", { headers: { Authorization: "Bearer s3cret-tokem" } })).status,
    ).toBe(401);
    expect(calls).toEqual([]);
  });

  it("answers only POST /sync with a known channel", async () => {
    expect((await sync("/other", auth)).status).toBe(404);
    expect((await sync("/sync", { ...auth, method: "GET" })).status).toBe(405);
    expect((await sync("/sync?channel=nightly", auth)).status).toBe(400);
    expect(calls).toEqual([]);
  });
});
