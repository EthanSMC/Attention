# URL ingestion fix validation, 2026-11-10

## Scope and provenance

Base: `ef02d97dfd0b1bcec991ba989604345706203291` from GitHub main.
The dedicated-browser PR #25 and Agent-Reach PR #26 were open drafts when
checked. Neither is merged or enabled by this fix.

The newer November 4 candidate already contained the essential XHS login
identity repair. This change ports that narrow repair and its synthetic
integration cases without overwriting or merging the broader candidate.
It adds independently runnable resolver regressions, rejects ambiguous duplicate
`redirectPath` values, and reports unresolved known shortlinks as pending.

## Defect and behavior

The collector already recognizes `xhslink.cn`. A shortlink or direct note can
resolve to the official XHS login page. Previously this discarded the note
identity and returned `invalid/non_content_target`.

The collector now preserves the original direct note or recovers a validated
note identity from the official HTTPS login page. It keeps the public access
parameters, query-free deduplication identity, shortlink alias, and pending
resolution state. Embedded HTTP note addresses are identity metadata only;
the collector constructs HTTPS access without requesting the embedded address.
It does not weaken DNS, TLS, redirect, credential, or public-address checks.

A known shortlink that remains unresolved, or reaches the official login page
without a target, returns `resolution_pending` instead of claiming the user
submitted an invalid link. Hostile and non-note targets remain rejected.

Saving a note is not proof that its body was read. Login/verification gates remain
explicit reader failures; this patch does not provide authenticated XHS access,
transcripts, or a generated summary.

## Cloud verification

- Full Vitest: **188 files passed, 8 skipped; 1,621 tests passed, 177 skipped,
  0 failed**. Includes 36 standalone candidate-resolution cases.
- Full ESLint: passed without errors or warnings.
- Full workspace TypeScript check: passed.
- Full recursive production build, including Next.js: passed.
- Agent installation, capability, and standalone CLI artifact checks: passed.
  Artifact scripts used Node's supported `--import` TypeScript loader because
  the tsx CLI's optional IPC listener is unavailable in this cloud sandbox.
- The migration CLI regression uses the same loader approach already present in
  the November 4 candidate. Its assertions are unchanged; no tests were removed.
- `git diff --check`: passed.

The PostgreSQL integration cases are included but **not run** here: this executor
has no PostgreSQL 17 or container runtime and no synthetic test database.
The skipped count is not a successful database or end-to-end acceptance result.

One anonymous production-safe reader control (`https://example.com/`) returned
`dns_failure` before HTTP. Network protections were left intact and platform
requests were not expanded after this environment failure. Previously blocked
platform samples were not retried through another provider. No real model was
called and no live URL-to-summary success is claimed.

No deployment, package release, production migration, real collection write,
WeChat send, browser-session transfer, or Mac network change was performed.
