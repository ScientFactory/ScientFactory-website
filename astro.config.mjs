import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://scientfactory.com",
  redirects: {
    "/download": "/about/#downloads",
    "/docs": "/docs/getting-started/",
  },
  server: {
    port: Number(process.env.PORT ?? 4173),
  },
});
