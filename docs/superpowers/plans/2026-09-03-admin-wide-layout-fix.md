# Admin Wide Layout Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove excessive left whitespace from `/admin/users` on wide desktop viewports while preserving safe gutters, table containment, and the existing mobile layout.

**Architecture:** Keep the existing `AdminShell` markup and data flow unchanged. Add a source-level CSS regression test, then replace the centered `1440px` cap with viewport-responsive safe gutters and tighten the desktop grid so the main column receives all remaining width.

**Tech Stack:** Next.js, React, CSS, Vitest, Playwright/browser QA, Docker Compose staging deployment

**Spec:** `docs/superpowers/specs/2026-09-03-admin-wide-layout-fix-design.md`

## Global Constraints

- Only management-layout CSS and its focused regression test may change.
- Desktop total horizontal gutter must stay between `32px` and `80px`.
- The page itself must not scroll horizontally; the users table may scroll only inside `.admin-users-table-wrap`.
- The existing layout transition at `780px` and below must remain usable.
- Entitlement APIs, authentication, mutations, and audit behavior must not change.

---

### Task 1: Lock the responsive admin layout contract

**Files:**
- Create: `apps/web/src/components/admin-shell-layout.test.ts`
- Modify: `apps/web/src/app/globals.css:48-76,538-542`

**Interfaces:**
- Consumes: CSS selectors `.admin-users-shell`, `.admin-shell`, and `.admin-users-table-wrap`.
- Produces: a tested layout contract with viewport-responsive safe gutters, a bounded sidebar, a flexible main column, and table-local horizontal overflow.

- [ ] **Step 1: Write the failing CSS regression test**

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(
  new URL("../app/globals.css", import.meta.url),
  "utf8",
);

function firstRule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return styles.match(new RegExp(`${escaped}\\s*\\{(?<body>[^}]+)\\}`, "u"))
    ?.groups?.body ?? "";
}

describe("admin shell responsive layout", () => {
  it("uses viewport-responsive desktop gutters instead of a centered width cap", () => {
    const shell = firstRule(".admin-users-shell");
    expect(shell).toContain("width: calc(100% - clamp(32px, 4vw, 80px))");
    expect(shell).toContain("max-width: none");
    expect(shell).not.toContain("1440px");
  });

  it("gives the main column remaining space and contains table overflow", () => {
    expect(firstRule(".admin-shell")).toContain(
      "grid-template-columns: clamp(190px, 15vw, 220px) minmax(0, 1fr)",
    );
    expect(firstRule(".admin-users-table-wrap")).toContain("overflow-x: auto");
  });
});
```

- [ ] **Step 2: Run the focused test and verify that the old width cap fails**

Run: `pnpm exec vitest run apps/web/src/components/admin-shell-layout.test.ts`

Expected: FAIL because `.admin-users-shell` still uses `width: min(1440px, calc(100% - 32px))` and `.admin-shell` still uses a fixed `220px` sidebar.

- [ ] **Step 3: Implement the responsive gutter and grid rules**

```css
.admin-users-shell {
  width: calc(100% - clamp(32px, 4vw, 80px));
  max-width: none;
  margin: 0 auto;
  padding: 40px 0 72px;
}

.admin-shell {
  display: grid;
  align-items: start;
  gap: clamp(20px, 2.5vw, 36px);
  grid-template-columns: clamp(190px, 15vw, 220px) minmax(0, 1fr);
}

@media (max-width: 780px) {
  .admin-users-shell {
    width: calc(100% - 20px);
    max-width: none;
    padding-top: 20px;
  }
}
```

- [ ] **Step 4: Run focused layout and shell tests**

Run: `pnpm exec vitest run apps/web/src/components/admin-shell-layout.test.ts apps/web/src/components/admin-shell.test.tsx`

Expected: both test files PASS.

- [ ] **Step 5: Commit the tested layout change**

```bash
git add apps/web/src/app/globals.css apps/web/src/components/admin-shell-layout.test.ts
git commit -m "fix(web): use wide admin workspace"
```

### Task 2: Verify and deploy the corrected layout

**Files:**
- Modify: none
- Verify: `apps/web/src/app/globals.css`
- Verify: `deploy/staging/RUNBOOK.md`

**Interfaces:**
- Consumes: the responsive layout contract from Task 1 and the existing staging deployment scripts.
- Produces: a CI-verified commit deployed to staging with a known rollback release.

- [ ] **Step 1: Run repository quality gates**

Run:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
git diff --check HEAD^ HEAD
```

Expected: every command exits `0`; existing explicitly skipped tests may remain skipped.

- [ ] **Step 2: Verify responsive geometry before deployment**

Open `/admin/users` with an authenticated staging-compatible local session at viewport widths `1280`, `1440`, `1800`, and `390`.

Expected at desktop widths: left and right page gutters are equal and at most `40px` each, `document.documentElement.scrollWidth === document.documentElement.clientWidth`, the main column expands with the viewport, and the table is not clipped by the page edge.

Expected at `390px`: the shell stacks, navigation remains reachable, and `.admin-users-table-wrap` has `overflow-x: auto` without causing page-level overflow.

- [ ] **Step 3: Push the exact commit and wait for CI**

Run:

```bash
git push origin HEAD:main
gh run list --branch main --limit 5
gh run watch <run-id> --exit-status
```

Expected: the workflow for the pushed SHA completes successfully.

- [ ] **Step 4: Deploy through the staging runbook**

On the staging host, fetch `origin/main`, check out the exact pushed SHA, run:

```bash
./deploy/staging/preflight.sh
./deploy/staging/deploy.sh
./deploy/staging/smoke-test.sh --public
```

Expected: backup/restore drill, image builds, migrations, runtime roles, service health checks, and public smoke checks all pass; the current release file records the pushed short SHA.

- [ ] **Step 5: Repeat live responsive and security verification**

Verify the deployed `/admin/users` at `1280`, `1440`, `1800`, and `390` using the same geometry assertions from Step 2. Confirm no new console warnings/errors, unauthenticated admin API requests remain `401`, HTTP redirects to HTTPS, and non-public staging ports remain closed using the proxy/TUN-safe procedure in `deploy/staging/RUNBOOK.md`.

- [ ] **Step 6: Record final evidence**

Report the deployed URL, exact release SHA, CI run, viewport geometry results, smoke-test results, and previous release available for rollback.
