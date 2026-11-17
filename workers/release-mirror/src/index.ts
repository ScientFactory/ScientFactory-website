// FILE: index.ts
// Purpose: Keeps downloads.scientfactory.com's copy of the Stable desktop installers and the
//          desktop app's Stable and Beta update feeds current.
// Layer: Cloudflare Worker (cron only; no public routes)

import { syncDesktopMirror } from "./mirror";
import { syncUpdateFeed } from "./updateFeed";

export default {
  async scheduled(controller, env) {
    const bucket = env.DESKTOP_DOWNLOADS;
    // Each step is independent: one failing (a release still uploading, GitHub refusing) must not
    // hold back the others. Steps run in turn so a release's shared installers are copied once.
    const steps = [
      [
        "Desktop mirror synchronized",
        () => syncDesktopMirror(bucket, new Date(controller.scheduledTime)),
      ],
      ["Stable update feed synchronized", () => syncUpdateFeed(bucket, "stable")],
      ["Beta update feed synchronized", () => syncUpdateFeed(bucket, "beta")],
    ] as const;
    const failures: unknown[] = [];
    for (const [message, run] of steps) {
      try {
        console.log(JSON.stringify({ message, ...(await run()) }));
      } catch (error) {
        failures.push(error);
        console.error(
          JSON.stringify({
            message: message.replace("synchronized", "failed"),
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `${failures.length} release mirror step(s) failed.`);
    }
  },
} satisfies ExportedHandler<Env>;
