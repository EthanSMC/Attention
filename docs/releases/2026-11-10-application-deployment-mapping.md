# Attention application and deployment mapping

Date: 2026-11-10. Status: **0.3.23-rc.1, unreleased and not deployed**.
This record is not approval for a tag, merge, migration or deployment. The user
separately approved publishing the implementation to a feature branch and
[draft PR #27](https://github.com/EthanSMC/Attention/pull/27), with CI. That public
review does not promote the RC or change the live application.

## Identity map

| Identity | Value and scope |
| --- | --- |
| Repository/application version | `0.3.23-rc.1`; canonical root `release.json`, mirrored by root `package.json`. |
| Candidate source provenance | Website-agent working tree based on reconciliation commit `b52a21547cd333308dfb63c2532008a212154c8d`. This base does **not** identify the final RC bytes. |
| Public review | Draft PR #27, remote branch `feat/native-pi-website-agent-20261110`; its latest immutable head and exact-head CI identify a review checkpoint, not a release tag or deployed image. |
| Final reviewed RC commit | Pending. Record the full immutable commit when final checks are complete. Do not use the base SHA for the changed working tree. |
| RC image/deployment ID | Pending the final reviewed commit. Keep the existing first-12-hex-character Git SHA convention, never the SemVer string. |
| Verified live baseline | `c0628d25e9fc573310e216304bf0a37c17ac780e`; inspected Web/Worker/Fetcher image release ID `c0628d25e9fc`; recorded schema `0038`. |
| Public main baseline | `ef02d97dfd0b1bcec991ba989604345706203291`; CLI/runtime `0.3.20`. |
| Retained CLI/runtime | `0.3.21`, unchanged package, runtime constant and public artifact manifest. |
| Retained CLI artifact | `apps/web/public/cli/attention-0.3.21.mjs`, SHA-256 `47ec8b0f7b7921d13979400a8b14a712301e737a4291ae91e3ceef1ae9052117`. |
| Retained Skill / tool contract | `1.10.0` / `1.7.0`. No synchronization to the application SemVer. |
| Website-agent dependency/storage versions | Pi SDK `0.85.1`; native session format `3`; application storage envelope `1` / `2` (backward compatible). These are not Attention release versions. |
| Independent integration candidate | `0.3.22`, unpublished, snapshot provenance `c1dbc27b5562579660c90de91980dc6ba2c07506`, based on `c0628d25e9fc573310e216304bf0a37c17ac780e`. Its browser/private-reading features are not imported here. |

The candidate snapshot's commit label is provenance, not proof that every
subsequently edited snapshot file equals that Git commit. The live values above
are previously verified observations, not a new live health or schema check.

Root and Web package `0.1.0` metadata did not supersede Attention's historical
0.2.x/0.3.x CLI release train. Root metadata now tracks the application RC;
private Web metadata remains separate. The withdrawn `0.2.0-rc.1` proposal
created no release and must not be revived as a version reset.

## Expected schema transition and exact SQL bytes

For this RC, the expected path is **0038 → 0039 budget → 0040 sessions**.
These checksums cover the complete SQL file bytes, not only migration names.
They identify the intended schema inputs, not evidence that a database has
applied them. Do not substitute another branch's similarly numbered migration.

| Order | Migration | SHA-256 |
| --- | --- | --- |
| Recorded live baseline | `0038_source_read_coordination.sql` | `51df66457e24edb2b5971b8adf3ce5fa530b6505fdd4bfde9b01396c5f1ed926` |
| First website-agent addition | `0039_website_agent_budget.sql` | `1b2782bb7d768ac256fdd2139d459009c206218b6e7f604926d48077b1bf3412` |
| Second website-agent addition | `0040_website_agent_sessions.sql` | `2ac6cf38ba72d8a1e1ae3d1e67861f0cc149297963a82051c3d23dc0e5f504ca` |

The preserved 0.3.22 integration candidate has a different migration:
`0039_dedicated_browser_private_evidence.sql`, measured SHA-256
`91570f74a5420ee901f39e9958bac55b3498ad8c6136bde873051f941dcb380a`.
It is not the website-agent budget migration. The branches are **not
schema-interchangeable**. Before any future merge, reconcile the intended
features and migration order, renumber the conflicting unapplied migration,
reconcile journal/snapshots and test each supported upgrade path. Never rewrite
already applied SQL or silently replace one `0039` with the other.

The existing staging rollback guard blocks application rollback when the live
schema differs from the previous release's recorded schema. A deployment that
advances 0038 to 0040 cannot be rolled back to the recorded 0038 application
using that script. Require a reviewed recovery/compatibility plan and verified
backup/restore before applying migrations; this change adds no down migration
and disables no rollback guard.

## Health metadata and checks

`GET /api/health` returns HTTP 200 with `Cache-Control: no-store` and exactly:

```json
{"status":"ok","version":"0.3.23-rc.1"}
```

The version is statically imported from root `release.json` and bundled with
the route. It requires no runtime filesystem lookup, environment-variable
override or Git checkout. Only the application version is exposed in addition
to the existing liveness status. No host, image ID, configuration, credential,
user information or session content is returned. This is **liveness**, not
database/schema readiness, feature enablement or approval to deploy.

Run `pnpm version:check` to verify canonical metadata consistency, the precise
health response, retained CLI artifact/manifest bytes, separate Skill/contract
versions, migration order and the three recorded SQL checksums. This focused
check is part of `pnpm test`, not a substitute for the complete suite.

## Promotion gates and final record

Keep this version an RC until the following have evidence for the final source:

1. Freeze a clean, reviewed commit. Run full tests, typecheck, lint and builds;
   validate the built/standalone health route reports the canonical version.
   Record the full SHA and each immutable image tag/digest. The deployment
   release ID remains the reviewed SHA's first 12 characters.
2. Validate the native-session lifecycle, cross-user isolation, encrypted
   persistence, cancellation, quota accounting and browser acceptance. A
   version response does not certify those behaviors.
3. Check the actual target schema and migration ledger against the expected
   0038 baseline and these checksums. Verify 0039 then 0040 against disposable
   PostgreSQL 17 with the runtime roles and supported upgrade path; do not
   confuse this evidence with having migrated the live target.
4. Review configuration and the intended rollout audience (`members` for all
   currently entitled members or `allowlist` for selected accounts), plus
   backup/restore and schema-aware rollback constraints. The feature stays
   disabled by default with `allowlist` as the safe audience default; neither
   mode bypasses authentication, membership or session-ownership checks.
   Obtain explicit approval before any publication or deployment.

In the final approved release record, include application `0.3.23-rc.1`, full
reviewed commit, SHA12 release ID, component image digests, separate CLI/Skill/
contract versions, pre/post schema heads, SQL checksums, exact-commit check
results and approval. Record actual deployment outcomes only after execution.
No final commit, image, schema transition or gate is marked complete merely
because the version metadata exists.
