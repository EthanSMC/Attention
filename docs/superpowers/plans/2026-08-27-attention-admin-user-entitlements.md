# Attention Admin User Entitlements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a hidden, same-origin `/admin/users` console that lets an email-allowlisted administrator search accounts, change Member/Filter entitlements one user at a time, and inspect an immutable audit trail.

**Architecture:** A server-only allowlist guard is enforced inside the admin data-access service as well as every page/API entrypoint. One transactional service derives current capabilities from the same entitlement, grant, subscription, and Filter-profile tables used by sessions; mutations update those tables and insert a structured audit row atomically. The page renders server-paginated data and delegates confirmed mutations to a small client control.

**Tech Stack:** TypeScript 6, Next.js 16 App Router/Route Handlers, React 19, Drizzle ORM, PostgreSQL 17, Zod, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-27-attention-admin-user-entitlements-design.md`

## Global Constraints

- New verification-code registrations keep the existing permanent `signup` entitlement with `member_enabled=true`; no default-entitlement switch is introduced.
- `ATTENTION_ADMIN_EMAILS` is a comma-separated, server-only list of normalized emails; missing or invalid configuration fails closed.
- `/admin/users` and every `/api/admin/*` read/write path re-check the authenticated session on the server before querying account data.
- There is no user navigation, account-page link, bulk mutation, admin delegation, or page-based admin creation.
- Each mutation requires a 3–500 character reason and `confirmed=true`, and records actor, target, before/after state, action, time, source, and request ID in the same transaction.
- Existing uncommitted scope/spec documents are preserved. No publish or deploy commands are run.

---

### Task 1: Server-only administrator access policy

**Files:**
- Create: `apps/web/src/server/admin-access.ts`
- Test: `apps/web/src/server/admin-access.test.ts`

**Interfaces:**
- Produces: `parseAdminEmailAllowlist(raw?: string): ReadonlySet<string>`, `isAdminPrincipal(principal: SessionPrincipal | null, raw?: string): boolean`, and `requireAdminPrincipal(principal, raw?): SessionPrincipal`.
- Produces: `AdminAccessError` with `authentication_required`, `admin_required`, or `admin_configuration_invalid`.

- [ ] **Step 1: Write failing tests for normalization, blank/invalid fail-closed behavior, missing email, and allowlisted/non-allowlisted principals.**

- [ ] **Step 2: Run `pnpm vitest run apps/web/src/server/admin-access.test.ts`; expect module-not-found or missing-export failures.**

- [ ] **Step 3: Implement the server-only parser and guard using `normalizeEmail` from `@attention/auth`; never log or include configured emails in errors.**

- [ ] **Step 4: Re-run the targeted test; expect all access-policy cases to pass.**

### Task 2: Structured audit schema and migration

**Files:**
- Modify: `packages/db/src/schema.ts`
- Create: next Drizzle migration and snapshot under `packages/db/drizzle/`
- Modify: `packages/db/drizzle/meta/_journal.json`
- Test: `packages/db/src/admin-entitlement-audit-schema.test.ts`

**Interfaces:**
- Produces: `AdminEntitlementState = { isFilter: boolean; isMember: boolean; tier: "free" | "member" | "filter" }`.
- Produces: `adminEntitlementAudits`, with actor/target account foreign keys, action, previous/next JSON state, reason, source, request ID, and occurrence time.

- [ ] **Step 1: Write a failing schema test asserting the exported table maps all required columns.**

- [ ] **Step 2: Run `pnpm vitest run packages/db/src/admin-entitlement-audit-schema.test.ts`; expect the missing export to fail.**

- [ ] **Step 3: Add the table, indexes, and database checks for allowed actions, nonblank reasons/source/request IDs, and actor/target lookup.**

- [ ] **Step 4: Run `pnpm db:generate`, inspect the generated SQL/snapshot, then run `pnpm vitest run packages/db/src/admin-entitlement-audit-schema.test.ts tests/migration-snapshot.test.ts`.**

### Task 3: Transactional admin user/entitlement service

**Files:**
- Create: `apps/web/src/server/admin-user-entitlements.ts`
- Test: `apps/web/src/server/admin-user-entitlements.test.ts`
- Test: `tests/integration/admin-user-entitlements.test.ts`

**Interfaces:**
- Produces: `listAdminUsers(db, principal, { query, tier, page, pageSize, now })` with database-side search, tier filtering, count, and pagination.
- Produces: `listAdminEntitlementAudits(db, principal, targetAccountId, limit)` with actor identity and structured states.
- Produces: `changeAdminUserEntitlement(db, principal, { action, targetAccountId, reason, requestId, source, now })` where action is `set_member | set_filter | revoke_filter`.
- Consumes: `requireAdminPrincipal` and `adminEntitlementAudits`.

- [ ] **Step 1: Write failing unit tests for bounded query/page input and reason/request validation, plus integration cases for search/tier pagination and all three entitlement transitions.**

- [ ] **Step 2: Run the unit test and the integration test against an isolated migrated PostgreSQL database; verify failures precede implementation.**

- [ ] **Step 3: Implement SQL `exists` expressions matching `resolveAccountCapabilities`, escaped contains-search, server pagination, and audit retrieval.**

- [ ] **Step 4: Implement a per-target advisory-locked transaction: ensure the target is active, derive before state, upsert the correct permanent Member entitlement, update/upsert Filter profile, derive after state, and insert audit.**

- [ ] **Step 5: Re-run service tests and assert mutations take effect immediately through `resolveAccountCapabilities` and audit rows contain no missing required field.**

### Task 4: Protected admin APIs

**Files:**
- Create: `apps/web/src/app/api/admin/users/route.ts`
- Create: `apps/web/src/app/api/admin/users/route.test.ts`
- Create: `apps/web/src/app/api/admin/users/[accountId]/audits/route.ts`
- Create: `apps/web/src/app/api/admin/users/[accountId]/audits/route.test.ts`
- Create: `apps/web/src/app/api/admin/users/[accountId]/entitlements/route.ts`
- Create: `apps/web/src/app/api/admin/users/[accountId]/entitlements/route.test.ts`

**Interfaces:**
- GET `/api/admin/users?q=&tier=&page=&page_size=` returns snake-case paginated account data.
- GET `/api/admin/users/:accountId/audits` returns that target's recent audit rows.
- POST `/api/admin/users/:accountId/entitlements` accepts `{ action, reason, confirmed: true }` and returns the resulting state plus `X-Request-ID`.

- [ ] **Step 1: Write failing route tests proving unauthenticated requests return 401, non-admin requests return 403 before service calls, malformed inputs return 400, and valid allowlisted calls serialize safely.**

- [ ] **Step 2: Run the three route tests and verify red failures.**

- [ ] **Step 3: Implement no-store Node.js Route Handlers with session lookup, double-enforced service authorization, same-origin/body limits on mutation, Zod schemas, safe error mapping, and bounded request correlation IDs.**

- [ ] **Step 4: Re-run the route tests; expect all authorization and serialization cases to pass.**

### Task 5: Hidden standalone admin page

**Files:**
- Create: `apps/web/src/app/admin/users/page.tsx`
- Create: `apps/web/src/app/admin/forbidden.tsx`
- Create: `apps/web/src/components/admin-user-entitlement-control.tsx`
- Create: `apps/web/src/components/admin-user-entitlement-control.test.tsx`
- Modify: `apps/web/src/components/site-navigation.tsx`
- Modify: `apps/web/src/components/site-navigation.test.tsx`
- Modify: `apps/web/src/app/globals.css`
- Modify: `apps/web/next.config.ts`

**Interfaces:**
- The page accepts `q`, `tier`, `page`, and `audit_user` search params and calls the guarded service directly.
- The client control opens a confirmation dialog only after a valid reason, posts `confirmed: true`, reports safe errors, and refreshes server data on success.

- [ ] **Step 1: Extend navigation tests so `/admin/users` renders neither desktop nor mobile user navigation; add component tests for reason gating and explicit confirmation copy/state.**

- [ ] **Step 2: Run the component/navigation tests; verify red failures.**

- [ ] **Step 3: Enable Next.js `authInterrupts`, add a noindex 403 boundary, and implement the force-dynamic server page: unauthenticated users redirect to login, non-admins invoke `forbidden()`, and authorized users see paginated filters, one-user actions, and selected-user audits.**

- [ ] **Step 4: Add restrained standalone styling and the client confirmation workflow without adding any link from user-facing pages.**

- [ ] **Step 5: Re-run component/navigation tests and web typecheck.**

### Task 6: Server environment wiring and safe local configuration

**Files:**
- Modify: `.env.example`
- Modify: `.env.compose.example`
- Modify: `compose.yaml`
- Modify: `deploy/staging/compose.env.example`
- Modify: `deploy/staging/generate-env.sh`
- Modify: `deploy/staging/validate-env.sh`
- Modify: `docs/deployment.md`
- Modify: `tests/compose-email-config.test.ts`
- Modify: `tests/staging-deployment.test.ts`
- Local ignored configuration: `apps/web/.env.local`

**Interfaces:**
- `ATTENTION_ADMIN_EMAILS` is passed only to the Web service and validated as one or more comma-separated normalized emails for staging.

- [ ] **Step 1: Extend environment tests to require Web-only passthrough, generated/example key parity, and fail-closed staging validation without printing values.**

- [ ] **Step 2: Run `pnpm vitest run tests/compose-email-config.test.ts tests/staging-deployment.test.ts`; verify red failures.**

- [ ] **Step 3: Wire/document the server-only variable and update staging generator/validator with value-redacting errors.**

- [ ] **Step 4: Because the local database has exactly one active verified email, set that value in ignored `apps/web/.env.local` through a non-echoing local query; do not print it in tools, logs, diffs, or the final report.**

- [ ] **Step 5: Re-run the environment tests and verify Git still ignores the local email file.**

### Task 7: Regression and build verification

**Files:**
- Review every changed file and generated migration artifact.

- [ ] **Step 1: Run targeted admin/schema/migration/environment/navigation tests.**

- [ ] **Step 2: Run `pnpm typecheck` and the main-tree ESLint command `pnpm exec eslint apps packages scripts tests vitest.config.ts`.**

- [ ] **Step 3: Run `pnpm test` and `pnpm build`; distinguish expected opt-in database skips from failures.**

- [ ] **Step 4: Inspect `git diff --check`, `git status --short`, and the complete diff; confirm no user-facing admin link, secret, unrelated edit, publish, or deploy action is present.**

- [ ] **Step 5: Report the local URL `/admin/users`, configuration mechanism, validation results, migration requirement, and whether the user must still supply an email.**
