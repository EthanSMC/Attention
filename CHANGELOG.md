# Attention development and release history

This records verified release identities and release candidates. A candidate
version is not a publication, tag, deployment, or production-readiness claim.

## 0.3.23-rc.1: native website agent (unreleased)

Selected on 2026-11-10 for repository/application version management after
reconciling Attention's existing 0.3.x history. This is a new application RC;
it does not republish or renumber the deployed CLI/runtime 0.3.21.

- Shares Attention's canonical tools/Core with personal-agent MCP connections.
- Uses native Pi AgentSession and SessionManager for per-user website sessions,
  native context restore and budgeted native compaction.
- Adds owner-isolated encrypted storage, optimistic revisions, reconnect/close/
  expiry, private-save consent, bounded usage and cancellation safeguards.
- Classifies all 16 canonical tool names. Adds Filter court reads and exact
  human-review gates for visibility, digest, report and vote actions, with
  one-time encrypted claims and atomic Core-effect/status receipts.
- Reads storage envelope 1 and 2; envelope 2 adds action metadata without
  replacing native Pi history. Candidate/public-collect and shared-enrichment
  execution still require their separate selection/evidence/merge review.
- Personal-agent credentials and private sessions remain separate.
- Supports configurable `members` or `allowlist` rollout audiences while
  retaining authentication, membership and session-ownership checks. The
  feature remains disabled by default; `allowlist` is the safe audience default.
- Database additions: 0039 website usage reservations and 0040 user sessions.
- Existing deployed 0.3.21 runtime/error handling is preserved byte-for-byte.
- Adds canonical root `release.json`, matching root package metadata and a
  bundled application version in `/api/health` with no configuration exposure.
- Keeps CLI/runtime 0.3.21, Skill 1.10.0 and tool contract 1.7.0 unchanged.
- Adds `pnpm version:check` for release metadata, health response, immutable CLI
  identity and the recorded SQL migration checksums.

The RC remains local pending final exact-commit checks, native-session and
database acceptance, and explicit release/deployment approval. It does not
overwrite the separate 0.3.22 candidate or include its unpublished features.
Image/deployment IDs remain the reviewed commit's 12-character SHA, with the
exact commit and migration checksums recorded separately. See the
[release/deployment mapping](docs/releases/2026-11-10-application-deployment-mapping.md).

## 0.3.22: existing unpublished integration candidate

The preserved November 4 candidate already uses this CLI/runtime version,
Skill 1.11.0 and tool contract 1.9.0. Its browser/private-reading integrations
are not silently included in the website-agent development branch. This is not
the currently deployed version.

Its `0039_dedicated_browser_private_evidence` migration differs from this RC's
`0039_website_agent_budget`. These branches are not schema-interchangeable;
reconcile and renumber conflicting migrations before any future merge.

## 0.3.21: verified deployed baseline

Live commit c0628d25e9fc573310e216304bf0a37c17ac780e includes 3888510 and c0628d2
after public main ef02d97. It preserves Xiaohongshu note identity through
official login redirects/HTTPS metadata and gives neutral, stable collection
failure explanations. Preserving a link does not mean its body was acquired.

CLI artifact SHA-256:
47ec8b0f7b7921d13979400a8b14a712301e737a4291ae91e3ceef1ae9052117.

## 0.3.20: public main baseline

Public main ef02d97 includes contextual reader recovery, CLI 0.3.20 and retention
of the immutable older artifact. Earlier history already contains 0.2.0,
0.2.1 and subsequent 0.3.x releases; no new 0.2.0 line is introduced here.

See the [version audit](docs/releases/2026-11-10-attention-version-history.md)
and [deployed-source reconciliation](docs/releases/2026-11-10-live-0.3.21-reconciliation.md).
