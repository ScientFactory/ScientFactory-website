# Contributing

All website work uses short-lived branches and pull requests into `main`.

1. Start from the current `main` branch.
2. Create an isolated branch such as `feature/...`, `fix/...`, `docs/...`, or `chore/...`.
3. Run `bun run check` locally.
4. Open a pull request and review its Cloudflare preview deployment.
5. Merge only after required checks pass and review conversations are resolved.

Never force-push or commit directly to `main`. Keep deployment credentials in GitHub or Cloudflare-managed secret storage.
