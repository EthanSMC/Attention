# Attention Admin Users UI Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `/admin/users` an independent account-style shell, lightweight user/audit navigation, and understandable entitlement action states while preserving every existing authorization and audit boundary.

**Architecture:** Keep the page as a request-time Server Component that authenticates and loads users/audits, add a server-safe `AdminShell` for identity and navigation, and keep entitlement mutations inside the existing Client Component. Pure navigation and action-state helpers make URL/state behavior testable without moving authorization into the browser.

**Tech Stack:** Next.js App Router, React 19, TypeScript 6, Vitest, PostgreSQL/Drizzle, project CSS design tokens, agent-browser.

**Spec:** `docs/superpowers/specs/2026-09-03-attention-admin-users-ui-interaction-fix-design.md`

## Global Constraints

- `/admin/users` remains a direct-only standalone route with no user-site navigation or account-page link.
- `ATTENTION_ADMIN_EMAILS` and every `/api/admin/*` server-side `requireAdminPrincipal` check remain unchanged.
- Reasons remain NFKC-normalized, trimmed, and 3–500 characters; `confirmed: true` remains mandatory.
- Only single-user `set_member`, `set_filter`, and `revoke_filter` actions are supported.
- Do not add bulk operations, administrator grants, deployment, remote pushes, or a merge from `main`.
- Reuse existing account/settings layout behavior and design tokens without coupling admin navigation to user routes.

---

### Task 1: Pure Admin Navigation and Independent Shell

**Files:**
- Create: `apps/web/src/lib/admin-users-navigation.ts`
- Create: `apps/web/src/lib/admin-users-navigation.test.ts`
- Create: `apps/web/src/components/admin-shell.tsx`
- Create: `apps/web/src/components/admin-shell.test.tsx`

**Interfaces:**
- Produces: `type AdminUsersTab = "audits" | "users"`.
- Produces: `parseAdminUsersTab(value: string | undefined): AdminUsersTab`.
- Produces: `adminUsersHref(input, options): string`, preserving `q`, `tier`, and `page`, and optionally adding `tab=audits` and `audit_user=<uuid>`.
- Produces: `AdminShell({ active, auditsHref, children, identity, usersHref })`, where `identity` contains `attentionId`, `displayName`, and `primaryEmail`.

- [ ] **Step 1: Write failing navigation tests**

Add literal expectations that `parseAdminUsersTab("audits")` returns `"audits"`, unknown input falls back to `"users"`, and:

```ts
expect(
  adminUsersHref(
    { page: 2, query: "reader", tier: "member" },
    { auditUser: "11111111-1111-4111-8111-111111111111", tab: "audits" },
  ),
).toBe(
  "/admin/users?q=reader&tier=member&page=2&tab=audits&audit_user=11111111-1111-4111-8111-111111111111",
);
```

- [ ] **Step 2: Run the navigation test and observe RED**

Run: `pnpm exec vitest run apps/web/src/lib/admin-users-navigation.test.ts`

Expected: FAIL because `admin-users-navigation.ts` does not exist.

- [ ] **Step 3: Implement the smallest URL/parser module**

Use `URLSearchParams`, emit query values in the tested order, omit page `1`, and add audit fields only for the audit Tab. Do not import React, Next.js, or server-only modules.

- [ ] **Step 4: Run the navigation test and observe GREEN**

Run: `pnpm exec vitest run apps/web/src/lib/admin-users-navigation.test.ts`

Expected: PASS.

- [ ] **Step 5: Write the failing shell test**

Render `AdminShell` to static markup and assert that it contains `Local Admin`, `local-admin@example.com`, `@admin_01`, `用户权限`, `审计记录`, `aria-current="page"` on the selected item, and no `/account` href.

- [ ] **Step 6: Run the shell test and observe RED**

Run: `pnpm exec vitest run apps/web/src/components/admin-shell.test.tsx`

Expected: FAIL because `admin-shell.tsx` does not exist.

- [ ] **Step 7: Implement `AdminShell`**

Create a Server Component that renders a read-only identity block and exactly two `next/link` navigation items. Use the administrator's first visible character as the avatar fallback and mark the selected link with `aria-current="page"`. Do not expose edit, account, home, or product navigation links.

- [ ] **Step 8: Run both Task 1 tests and observe GREEN**

Run: `pnpm exec vitest run apps/web/src/lib/admin-users-navigation.test.ts apps/web/src/components/admin-shell.test.tsx`

Expected: 2 test files pass with no warnings.

- [ ] **Step 9: Commit Task 1**

```bash
git add apps/web/src/lib/admin-users-navigation.ts apps/web/src/lib/admin-users-navigation.test.ts apps/web/src/components/admin-shell.tsx apps/web/src/components/admin-shell.test.tsx
git commit -m "feat(web): add independent admin shell"
```

### Task 2: Explain Every Entitlement Action State

**Files:**
- Modify: `apps/web/src/components/admin-user-entitlement-control.tsx`
- Modify: `apps/web/src/components/admin-user-entitlement-control.test.tsx`

**Interfaces:**
- Produces: `adminEntitlementReasonMessage(value: string): string`.
- Produces: `adminEntitlementActionDisabledReason({ action, currentTier, pending, reason }): string | null`.
- Preserves: `isValidAdminEntitlementReason(value: string): boolean` and the existing POST route/payload.

- [ ] **Step 1: Write failing reason-message tests**

Add hand-derived expectations:

```ts
expect(adminEntitlementReasonMessage("")).toBe(
  "先填写至少 3 个字符的变更原因。",
);
expect(adminEntitlementReasonMessage("好")).toBe(
  "还需填写 2 个字符，才能选择操作。",
);
expect(adminEntitlementReasonMessage("通过了")).toBe(
  "原因已满足要求，请选择操作。",
);
```

- [ ] **Step 2: Run the component test and observe RED**

Run: `pnpm exec vitest run apps/web/src/components/admin-user-entitlement-control.test.tsx`

Expected: FAIL because `adminEntitlementReasonMessage` is not exported.

- [ ] **Step 3: Implement normalized reason messages**

Compute the message from the same NFKC-normalized, trimmed string used by validation. Keep the maximum at 500 and do not weaken route validation.

- [ ] **Step 4: Run the component test and observe GREEN**

Run: `pnpm exec vitest run apps/web/src/components/admin-user-entitlement-control.test.tsx`

Expected: PASS.

- [ ] **Step 5: Write failing action-state tests**

Cover these independent behaviors with literal results:

```ts
expect(adminEntitlementActionDisabledReason({
  action: "set_member", currentTier: "member", pending: false, reason: "通过了",
})).toBe("当前已是 Member。");
expect(adminEntitlementActionDisabledReason({
  action: "set_filter", currentTier: "member", pending: false, reason: "短",
})).toBe("还需填写 2 个字符，才能选择操作。");
expect(adminEntitlementActionDisabledReason({
  action: "set_filter", currentTier: "member", pending: false, reason: "审核通过",
})).toBeNull();
```

Also cover `revoke_filter` outside Filter and the pending request state.

- [ ] **Step 6: Run the component test and observe RED**

Run: `pnpm exec vitest run apps/web/src/components/admin-user-entitlement-control.test.tsx`

Expected: FAIL because `adminEntitlementActionDisabledReason` is not exported.

- [ ] **Step 7: Implement action-state explanations and accessible markup**

Derive `disabled` from the helper. Give the textarea a stable `id`, render a persistent reason message beneath it, associate action buttons with that message using `aria-describedby`, and expose state-specific disabled explanations in visible copy plus each disabled button's `title`. Keep the confirmation dialog and POST implementation intact.

- [ ] **Step 8: Run the component test and observe GREEN**

Run: `pnpm exec vitest run apps/web/src/components/admin-user-entitlement-control.test.tsx`

Expected: PASS, including static markup assertions for the initial instruction and accessible associations.

- [ ] **Step 9: Commit Task 2**

```bash
git add apps/web/src/components/admin-user-entitlement-control.tsx apps/web/src/components/admin-user-entitlement-control.test.tsx
git commit -m "fix(web): explain admin entitlement action states"
```

### Task 3: Integrate Tabs and Account-Style Responsive Layout

**Files:**
- Modify: `apps/web/src/app/admin/users/page.tsx`
- Modify: `apps/web/src/app/globals.css`
- Modify: `apps/web/src/components/admin-shell.test.tsx`
- Modify: `apps/web/src/components/site-navigation.test.tsx`

**Interfaces:**
- Consumes: `AdminShell`, `AdminUsersTab`, `adminUsersHref`, and `parseAdminUsersTab` from Task 1.
- Preserves: `AdminUserEntitlementControl` props and every server-side access check.

- [ ] **Step 1: Extend failing shell/navigation markup tests**

Assert that the shell has `aria-label="管理端导航"`, the identity block precedes the navigation in rendered markup, and product `SiteHeader`/`MobileNavigation` remain absent for `/admin/users?tab=audits` as well as `/admin/users`.

- [ ] **Step 2: Run the targeted tests and observe RED**

Run: `pnpm exec vitest run apps/web/src/components/admin-shell.test.tsx apps/web/src/components/site-navigation.test.tsx`

Expected: at least the new shell structure assertion fails before integration markup is finalized.

- [ ] **Step 3: Integrate the independent shell into the page**

Add `tab?: SearchValue`, parse it with `parseAdminUsersTab`, and render:

- `AdminShell` with the current principal identity and preserved filter/page links.
- The existing filters, user table, actions, and pagination only for `activeTab === "users"`.
- The audit panel only for `activeTab === "audits" && selectedAccountId && audits`.
- A read-only empty state with a `返回用户权限` link for the audit Tab without a selected account.
- Each `查看审计` link with `{ tab: "audits", auditUser: user.accountId }`.

Continue to call `getPagePrincipal()` and `requireAdminPrincipal()` before any user/audit query. Keep invalid UUID handling and target-not-found behavior.

- [ ] **Step 4: Replace standalone admin CSS with token-based shell styles**

Use the established `--canvas`, `--surface`, `--surface-muted`, `--ink`, `--muted`, `--line`, `--line-strong`, `--radius-control`, `--radius-card`, spacing, and font variables. Desktop uses a sticky identity/navigation rail and a flexible content column; at `max-width: 780px`, identity becomes a top summary, navigation becomes horizontally scrollable, and the existing table wrapper remains horizontally scrollable.

Style reason help, state notes, enabled actions, disabled actions, audit empty state, keyboard focus, and confirmation layout. Do not introduce a new palette or font.

- [ ] **Step 5: Run targeted component and navigation tests**

Run: `pnpm exec vitest run apps/web/src/lib/admin-users-navigation.test.ts apps/web/src/components/admin-shell.test.tsx apps/web/src/components/admin-user-entitlement-control.test.tsx apps/web/src/components/site-navigation.test.tsx`

Expected: PASS.

- [ ] **Step 6: Run admin route/security tests**

Run: `pnpm exec vitest run apps/web/src/server/admin-access.test.ts apps/web/src/server/admin-user-entitlements.test.ts apps/web/src/app/api/admin/users/route.test.ts 'apps/web/src/app/api/admin/users/[accountId]/entitlements/route.test.ts' 'apps/web/src/app/api/admin/users/[accountId]/audits/route.test.ts'`

Expected: PASS; unauthorized paths do not call the services, invalid reasons/confirmation remain rejected, and success keeps request correlation.

- [ ] **Step 7: Commit Task 3**

```bash
git add apps/web/src/app/admin/users/page.tsx apps/web/src/app/globals.css apps/web/src/components/admin-shell.test.tsx apps/web/src/components/site-navigation.test.tsx
git commit -m "feat(web): refine admin users workspace"
```

### Task 4: Real API, Responsive QA, and Final Verification

**Files:**
- Modify only if a verified defect requires a new failing test and minimal fix.

**Interfaces:**
- Exercises: the actual Next.js page, `/api/admin/users/:accountId/entitlements`, PostgreSQL entitlement resolution, and audit persistence.

- [ ] **Step 1: Start an isolated local database and migrate it**

Create a temporary PostgreSQL data directory under `/private/tmp`, run it on a non-default loopback port, and call `migrateDatabase` directly for this disposable PostgreSQL 16 QA database because the production migration CLI deliberately requires PostgreSQL 17. Never point test commands at a development, staging, or production database.

- [ ] **Step 2: Seed an administrator, Member target, entitlements, and administrator session**

Use `@attention/db` inserts plus `@attention/auth` `issueSession`. Set `ATTENTION_ADMIN_EMAILS=local-admin@example.com`, keep the emitted session token only in the temporary browser state, and use the non-secure development session cookie name.

- [ ] **Step 3: Start the Next.js development server with isolated environment values**

Set the temporary `DATABASE_URL`, a 32+ character `ATTENTION_AUTH_SECRET`, `NEXT_PUBLIC_APP_URL=http://127.0.0.1:<port>`, and the administrator allowlist. Do not start the worker, fetcher, deployment, or any remote service.

- [ ] **Step 4: Verify the initial disabled state in a real browser**

With agent-browser, open `/admin/users`, capture desktop and mobile screenshots, verify the left/top administrator identity and two Tabs, and confirm that an applicable action is disabled with an explicit minimum-reason explanation.

- [ ] **Step 5: Verify the real POST and audit flow**

Enter a 3+ character reason, verify the applicable action becomes enabled, open the confirmation dialog, confirm, and inspect the actual network request/response. Verify the target tier changes after refresh and that the audit Tab shows the matching action, normalized reason, actor, time, source, and request ID.

- [ ] **Step 6: Verify security invariants from outside the administrator session**

Call the list and mutation APIs without the session cookie and confirm 401. Use the existing automated route tests to confirm a logged-in non-allowlisted principal receives 403. Verify no `/admin` link appears on `/ai`, `/account`, or user navigation markup.

- [ ] **Step 7: Run fresh final checks**

```bash
pnpm exec vitest run apps/web/src/lib/admin-users-navigation.test.ts apps/web/src/components/admin-shell.test.tsx apps/web/src/components/admin-user-entitlement-control.test.tsx apps/web/src/components/site-navigation.test.tsx apps/web/src/server/admin-access.test.ts apps/web/src/server/admin-user-entitlements.test.ts apps/web/src/app/api/admin/users/route.test.ts 'apps/web/src/app/api/admin/users/[accountId]/entitlements/route.test.ts' 'apps/web/src/app/api/admin/users/[accountId]/audits/route.test.ts'
pnpm --filter @attention/web typecheck
pnpm --filter @attention/web build
git diff --check
git status --short
```

Expected: every command exits 0; status contains only the intentional work plus the pre-existing untracked `.codex/` directory.

- [ ] **Step 8: Commit any final verified fixes**

If Step 4–7 required a defect fix, first add a failing regression test, observe RED, implement the minimal fix, observe GREEN, and commit only those files. Otherwise do not create an empty commit.
