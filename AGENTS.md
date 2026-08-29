# AGENTS.md

Follow [CONTRIBUTING.md](CONTRIBUTING.md) for branch, verification, Quality
Review, Integration Readiness Review, human preview review, and pull-request
evidence requirements. Treat review topics as starting points rather than
limits, and never substitute automated or agent-operated evidence for required
human preview review.

Before cross-repository work, read the [repository family](README.md#repository-family).
Keep each repository's changes on separate branches, worktrees, commits, and
pull requests, and state dependencies explicitly.

Current app-help prose is authored in `scient-desktop/docs/user/`; this website
must render an approved exact source/version instead of maintaining a second
copy. Website Docs work owns rendering, navigation, search, accessibility,
deployment, and truthful version/source selection. A change to app behavior or
source prose uses a separate desktop pull request with explicit landing order.
Use the exact-source manifest transport recorded in
`docs/architecture/scient-docs-publishing.md`; replace it only through a
reviewed architecture change with concrete evidence.

Every pull request includes one `Documentation impact` declaration: `None —
reason`, `Updated — paths`, or `Dependent PR — repository and link`. For Docs
publishing changes, also name the exact source/version affected in that same
declaration.
