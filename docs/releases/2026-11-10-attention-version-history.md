# Attention version history audit

Date: 2026-11-10. Status: lineage verified; application **0.3.23-rc.1** selected
for local repository version management. Unreleased and not deployed.

The earlier independent application `0.2.0-rc.1` proposal is withdrawn. The
user clarified that Attention already has version history. Empty GitHub tags
and private `0.1.0` package metadata were insufficient grounds to start a
new product version line. No tag, release manifest, package version change,
publication, or deployment resulted from that withdrawn proposal. The current
0.3.23-rc.1 selection instead continues the existing lineage and preserves the
already assigned 0.3.22 candidate identity.

## Verified release lineage

| Source | Identity | Evidence and scope |
| --- | --- | --- |
| Historical CLI/runtime | `0.2.0`, then `0.2.1`, then `0.3.x` | `apps/cli/src/version.ts` in Git history: `ccab390` (2026-08-11) is already `0.2.0`; `cd3dda7` is `0.2.1`; `ffe9c9c` is `0.3.0`. |
| Public GitHub main | CLI/runtime `0.3.20` | Main `ef02d97dfd0b1bcec991ba989604345706203291`; version introduced by `9ffccc7`; package, runtime constant, and public CLI manifest agree. |
| Live staging checkout | CLI/runtime `0.3.21` | Read-only host check by the validation task: `/opt/attention-staging/app` at `c0628d25e9fc573310e216304bf0a37c17ac780e`; package, runtime constant, and public CLI manifest all say `0.3.21`. |
| Preserved integration candidate | CLI/runtime `0.3.22`, unpublished | `apps/cli/package.json`, `apps/cli/src/version.ts`, and `apps/web/public/cli/manifest.json` in the preserved November 4 source snapshot agree. Its handoff explicitly calls this a local candidate. |
| Native website-agent application candidate | Application `0.3.23-rc.1`, unreleased | Root `release.json` is now canonical for the repository/application; root package metadata agrees. It retains deployed CLI/runtime `0.3.21`, not the separate `0.3.22` candidate's features. |

The established observable release sequence is therefore **public main
0.3.20 → deployed 0.3.21 → existing integration candidate 0.3.22 → application
candidate 0.3.23-rc.1**. These are
not invented versions and are not inferred from Git tags.

`apps/cli/src/version.ts` explicitly describes its constant as the “Single
source of truth for the published Attention CLI/runtime version.” This
establishes a real release train. The newly introduced root `release.json`
separately names the application release. Application changes do not force a
CLI republish, and historical CLI numbers are not retroactively asserted as
previously declared application-wide metadata.

The preserved snapshot's `SOURCE-MANIFEST.json` identifies source base
`c0628d25e9fc573310e216304bf0a37c17ac780e`, candidate commit
`c1dbc27b5562579660c90de91980dc6ba2c07506`, and candidate name
`reviewed-platform-reader-integration-20261104-v2`. The extracted tree is not
a Git checkout and has been used for subsequent cloud validation/fixes;
the manifest's commit label is provenance, not proof that every current file
still equals that commit.

The preserved `attention-0.3.22.mjs` artifact was hashed during this audit.
Its SHA-256 matches its current manifest:
`cf895f3faa7652609581e5d46b0a6844f7065ccfd030ab134857d37480ac0a12`.
The same snapshot retains `0.3.17` through `0.3.22` CLI artifacts.

## Other versions must not be conflated

- Public main's Skill is `1.10.0`; its MCP tool contract is `1.7.0`.
- The preserved integration candidate's Skill is `1.11.0`; its MCP tool
  contract is `1.9.0`. The handoff explicitly marks these unpublished too.
- Before this change, root and Web private package metadata were `0.1.0`;
  inspected live root metadata was also `0.1.0`. They did not identify the
  product's latest release. Root metadata now mirrors application
  `0.3.23-rc.1`; Web's private package metadata stays `0.1.0` and is not the
  application-version source.
- The website-agent working tree pins Pi SDK packages to `0.85.1`, accepts
  native Pi session format `3`, and stores application envelope versions
  `1` / `2` (backward compatible). None of these is an Attention product release number.
- Product documents use “V1 / first release” as a scope label, not a verified
  SemVer release history.

## Application/deployment identity

Existing staging releases use the full reviewed Git commit plus its first
12 hex characters as the image/deployment release ID. The reported live
Web/Worker/Fetcher images are tagged `c0628d25e9fc`; the database is at
`0038`. This application RC expects `0039_website_agent_budget`, then
`0040_website_agent_sessions`.
SemVer must not replace the hex release ID without an intentional deployment
contract change.

The live root inspection found no version/changelog/release-named file.
Public GitHub tag refs and Releases were empty at inspection. No independent
product-wide SemVer source was found in the checked public main, preserved
candidate, or live root version files. This is a verification limit, not
proof that no such convention exists elsewhere.

The selected application number is **0.3.23-rc.1**. Its canonical root
`release.json` contains only `version`, and root `package.json` mirrors it.
`/api/health` statically imports that JSON at build time and returns only
`status` and `version`; it does not read runtime package files, Git, environment
variables, credentials or deployment hosts. The response is a liveness check,
not a database/schema-readiness or release-acceptance assertion.

CLI/runtime `0.3.21`, its immutable artifact and manifest, Skill `1.10.0`, and
tool contract `1.7.0` remain unchanged. Pi SDK `0.85.1`, native session format
`3`, and the storage envelope `1` / `2` (backward compatible) remain independent version domains. No tag,
push, publication, deployment or external write is part of this version change.

The initial audit found that the live commit was absent from this feature
checkout and its public GitHub lookup returned 422. Read-only live Git inspection confirmed that it is exactly two commits beyond
`ef02d97`: `3888510` and `c0628d2`, both Xiaohongshu identity/error handling
repairs with the 0.3.21 CLI artifact. Local reconciliation commit
`b52a21547cd333308dfb63c2532008a212154c8d` restores the verified source delta and
byte-identical 0.3.21 artifact; this does not claim identical Git ancestry. See
the [reconciliation record](2026-11-10-live-0.3.21-reconciliation.md).

The [release/deployment mapping](2026-11-10-application-deployment-mapping.md)
records the distinct identities, exact SQL SHA-256 values, expected schema
transition and remaining gates. The final RC commit/image ID are still pending
the final reviewed commit, not inferred from the reconciliation base.
Applying 0039/0040 advances the schema; the current rollback script blocks app
rollback to a recorded 0038 schema.

The preserved 0.3.22 candidate instead contains
`0039_dedicated_browser_private_evidence`, SHA-256
`91570f74a5420ee901f39e9958bac55b3498ad8c6136bde873051f941dcb380a` as measured
from the preserved snapshot. Its `0039` is not this RC's budget migration.
The branches are not schema-interchangeable. Reconcile migration names,
journal entries and snapshots and renumber conflicts before a future merge;
never mutate already applied migration bytes or resolve the collision by
silently choosing one branch's file.

This version record does not certify native cross-user session isolation,
database migrations, browser acceptance, full final-commit CI, or deployment
readiness. Those require their own exact-commit evidence before promoting
the RC. No secrets or actual environment files were read for this audit.
