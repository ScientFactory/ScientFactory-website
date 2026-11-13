// FILE: index.ts
// Purpose: Keeps downloads.scientfactory.com's copy of the Stable desktop installers current.
// Layer: Cloudflare Worker (cron only; no public routes)

import { syncDesktopMirror } from "./mirror";

export default {
  async scheduled(controller, env) {
    const result = await syncDesktopMirror(
      env.DESKTOP_DOWNLOADS,
      new Date(controller.scheduledTime),
    );
    console.log(JSON.stringify({ message: "Desktop mirror synchronized", ...result }));
  },
} satisfies ExportedHandler<Env>;
