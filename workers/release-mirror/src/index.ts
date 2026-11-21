// FILE: index.ts
// Purpose: Keeps downloads.scientfactory.com's copy of the Stable desktop installers and the
//          desktop app's Stable and Beta update feeds current.
// Layer: Cloudflare Worker (cron, plus one authenticated trigger for the release workflow)

import { syncDesktopMirror } from "./mirror";
import { syncUpdateFeed } from "./updateFeed";

export type MirrorChannel = "stable" | "beta";

interface MirrorEnv extends Env {
  /**
   * Bearer token the desktop release workflow sends to `POST /sync` right after it publishes.
   * Unset, the trigger answers 404 and only the schedule runs.
   */
  readonly MIRROR_SYNC_TOKEN?: string;
}

/** One line of a run's report, as logged and as streamed to the release workflow. */
export type MirrorReportLine = Readonly<Record<string, unknown>> & { readonly message: string };

/**
 * Runs the steps for `channels` in turn and reports each one. Each step is independent: one
 * failing (a release still uploading, GitHub refusing) must not hold back the others.
 *
 * The Stable update feed runs before the download-page mirror. The feed copies every Stable
 * installer with its update manifest's SHA-512 as well as the handoff's SHA-256, so the mirror
 * step then finds each one already verified. In the other order, the feed step had to read every
 * installer back from R2 to hash it again, which pushed a release past the CPU limit. That still
 * happens once when the feed step fails and the mirror step copies the installers alone (GitHub's
 * release feed not listing the release yet, say): later feed runs read them back until one
 * publishes the release.
 */
export async function runMirror(
  bucket: R2Bucket,
  now: Date,
  channels: readonly MirrorChannel[],
  report: (line: MirrorReportLine) => void,
): Promise<number> {
  const steps: Array<readonly [string, () => Promise<object>]> = [];
  if (channels.includes("stable")) {
    steps.push(["Stable update feed synchronized", () => syncUpdateFeed(bucket, "stable")]);
    steps.push(["Desktop mirror synchronized", () => syncDesktopMirror(bucket, now)]);
  }
  if (channels.includes("beta")) {
    steps.push(["Beta update feed synchronized", () => syncUpdateFeed(bucket, "beta")]);
  }
  let failures = 0;
  for (const [message, run] of steps) {
    try {
      report({ message, ...(await run()) });
    } catch (error) {
      failures += 1;
      report({
        message: message.replace("synchronized", "failed"),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return failures;
}

const ALL_CHANNELS: readonly MirrorChannel[] = ["stable", "beta"];
const HEARTBEAT_MS = 15_000;

function logLine(line: MirrorReportLine): void {
  const text = JSON.stringify(line);
  if ("error" in line) console.error(text);
  else console.log(text);
}

async function sameToken(given: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(given)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  // Equal-length digests compared without an early exit, so timing reveals nothing of the token.
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let difference = 0;
  for (let index = 0; index < x.length; index += 1) difference |= x[index]! ^ y[index]!;
  return difference === 0;
}

/**
 * `POST /sync?channel=stable|beta` runs the mirror now instead of at the next scheduled tick.
 * The report streams back as one JSON object per line, with a heartbeat while a step copies,
 * and ends with `{"message":"Release mirror finished","failures":n}`. The run lasts only while
 * the caller stays connected; a run cut short resumes from the bucket at the next tick.
 */
async function handleSync(request: Request, env: MirrorEnv): Promise<Response> {
  const url = new URL(request.url);
  const expected = env.MIRROR_SYNC_TOKEN;
  if (url.pathname !== "/sync" || !expected) return new Response(null, { status: 404 });
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  }
  const given = /^Bearer (.+)$/u.exec(request.headers.get("Authorization") ?? "")?.[1];
  if (given === undefined || !(await sameToken(given, expected))) {
    return new Response(null, { status: 401 });
  }
  const requested = url.searchParams.get("channel");
  if (requested !== null && requested !== "stable" && requested !== "beta") {
    return new Response("channel must be stable or beta\n", { status: 400 });
  }
  const channels: readonly MirrorChannel[] = requested === null ? ALL_CHANNELS : [requested];

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  // Writes are serialized, and a caller that went away only stops the report, not the logs.
  let pending = Promise.resolve();
  const send = (line: MirrorReportLine) => {
    pending = pending
      .then(() => writer.write(encoder.encode(`${JSON.stringify(line)}\n`)))
      .catch(() => undefined);
  };
  void (async () => {
    send({ message: "Release mirror started", channels });
    const heartbeat = setInterval(() => send({ message: "Release mirror working" }), HEARTBEAT_MS);
    try {
      const failures = await runMirror(env.DESKTOP_DOWNLOADS, new Date(), channels, (line) => {
        logLine(line);
        send(line);
      });
      send({ message: "Release mirror finished", failures });
    } finally {
      clearInterval(heartbeat);
      await pending;
      await writer.close().catch(() => undefined);
    }
  })();
  return new Response(readable, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export default {
  async scheduled(controller, env) {
    const failures = await runMirror(
      env.DESKTOP_DOWNLOADS,
      new Date(controller.scheduledTime),
      ALL_CHANNELS,
      logLine,
    );
    if (failures > 0) throw new Error(`${failures} release mirror step(s) failed.`);
  },
  fetch: handleSync,
} satisfies ExportedHandler<MirrorEnv>;
