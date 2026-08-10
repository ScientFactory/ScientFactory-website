# Contributing

All website work uses short-lived branches and pull requests into `main`.

1. Start from the current `main` branch.
2. Create an isolated branch such as `feature/...`, `fix/...`, `docs/...`, or `chore/...`.
3. Open a draft pull request when its Cloudflare preview or early feedback will
   help.
4. Run `bun run check` locally and complete Quality Review before presenting the
   pull request as ready.
5. For every user-visible change, have a human review the exact Cloudflare
   preview on desktop and on relevant mobile sizes. Automated screenshots,
   browser checks, and agent-operated review support but do not replace human
   product judgment. If a human cannot inspect the required preview, the change
   is not integration-ready.
6. Complete Integration Readiness Review against the exact final head. Merge
   only after required checks pass, review conversations are resolved, and the
   candidate is ready to deploy to production.

Never force-push or commit directly to `main`. Keep deployment credentials in GitHub or Cloudflare-managed secret storage.

## Quality Review

Establish the intended experience and acceptance criteria, then review the
complete candidate diff, affected content, tests, and configuration. Start with
reuse, quality, and efficiency, then follow any material concern the change
reveals. Record findings and their dispositions rather than treating these
prompts as limits.

## Integration Readiness Review

Before merge, inspect the exact final head, intended experience, evidence,
conversations, and production impact. Follow relevant correctness, security,
privacy, performance, accessibility, responsive, interaction, deployment, and
rollback risks without treating those topics as boundaries.

Investigate broadly and report precisely. Validate an alleged defect against
the current code and evidence with a concrete trigger, affected invariant,
observable impact, and root cause. For other material findings, name the
relevant principle and practical consequence. Keep missing evidence distinct
from a proven defect, state material uncertainty, and consolidate duplicate
symptoms.

Treat tests, fixtures, and workflows as evidence-bearing code. Confirm that
green results were not obtained by weakening assertions, removing meaningful
cases, making required checks conditional or non-blocking, or merely changing
fixtures to accept the new output. Intentional verification-gate changes must
be explicit and justified.

When separate perspectives would improve confidence and capable review agents
are available, use them independently and read-only, then reconcile their
findings. Reviewer arrangement is risk-based. Recheck only what later changes
could invalidate, but issue the final verdict for the new head. One proportional
pass may satisfy both stages for a small unchanged candidate.

Peer review is useful when it adds judgment but is not a default non-author
approval gate. The author, product owner, or another suitable human may perform
the preview review.
