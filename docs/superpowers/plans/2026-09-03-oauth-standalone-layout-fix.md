# OAuth Standalone Layout Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Center `/oauth/authorize` against the full viewport without rendering or reserving space for the product navigation shell.

**Architecture:** Preserve the existing OAuth page and navigation path checks. Add a browser geometry regression test using the real root-layout nesting, then introduce an OAuth-specific `body:has(.oauth-consent-shell)` page state that clears the global desktop sidebar offset and mobile-navigation bottom reservation.

**Tech Stack:** Next.js, React, CSS, Vitest, Playwright

**Spec:** `docs/superpowers/specs/2026-09-03-oauth-standalone-layout-fix-design.md`

## Global Constraints

- Do not modify OAuth validation, authentication, permission presentation, confirmation, cancellation, or token issuance.
- Do not render SiteHeader, collection actions, MobileNavigation, or another product-site entry point on OAuth routes.
- Keep the consent shell `max-width: 880px` and center it against the complete viewport.
- Keep the page free of horizontal overflow at `1280px`, `1440px`, `1800px`, and `390px`.
- Commit and verify locally only; do not push, publish, or deploy.

---

### Task 1: Lock and fix the OAuth root-layout geometry

**Files:**
- Create: `tests/e2e/oauth-standalone-layout.spec.ts`
- Modify: `apps/web/src/app/globals.css:4809`

**Interfaces:**
- Consumes: the real `body > main > .oauth-consent-shell > .oauth-consent` nesting and the existing global desktop `main` offset.
- Produces: an OAuth-specific page state in which the root `<main>` spans the viewport, the consent shell remains centered, and unused mobile-navigation space is removed.

- [ ] **Step 1: Write the failing browser geometry test**

```ts
import { readFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";

const stylesheetUrl = new URL(
  "../../apps/web/src/app/globals.css",
  import.meta.url,
);

test("centers standalone OAuth consent against the complete viewport", async ({
  page,
}) => {
  const stylesheet = await readFile(stylesheetUrl, "utf8");
  await page.setContent(`
    <style>${stylesheet}</style>
    <main id="main-content">
      <div class="oauth-consent-shell">
        <section class="oauth-consent"><h1>授权 Agent</h1></section>
      </div>
    </main>
  `);

  for (const width of [1280, 1440, 1800, 390]) {
    await page.setViewportSize({ height: 900, width });
    const geometry = await page.evaluate((viewportWidth) => {
      const rootMain = document.querySelector<HTMLElement>("body > main");
      const shell = document.querySelector<HTMLElement>(".oauth-consent-shell");
      if (!rootMain || !shell) throw new Error("OAuth fixture is incomplete");
      const shellRect = shell.getBoundingClientRect();
      return {
        bodyPaddingBottom: getComputedStyle(document.body).paddingBottom,
        pageFits: document.documentElement.scrollWidth === document.documentElement.clientWidth,
        rootMainLeft: rootMain.getBoundingClientRect().left,
        shellLeft: shellRect.left,
        shellRight: viewportWidth - shellRect.right,
        shellWidth: shellRect.width,
      };
    }, width);

    expect(geometry.rootMainLeft, `viewport ${width}`).toBe(0);
    expect(Math.abs(geometry.shellLeft - geometry.shellRight), `viewport ${width}`).toBeLessThan(1);
    expect(geometry.shellWidth, `viewport ${width}`).toBeLessThanOrEqual(880);
    expect(geometry.pageFits, `viewport ${width}`).toBe(true);
    expect(geometry.bodyPaddingBottom, `viewport ${width}`).toBe("0px");
  }
});
```

- [ ] **Step 2: Run the test and verify the current product-shell offset fails**

Run: `pnpm exec playwright test tests/e2e/oauth-standalone-layout.spec.ts`

Expected: FAIL at `1280px` because `body > main` starts at `216px` and the consent shell's left/right viewport margins differ by `216px`.

- [ ] **Step 3: Add the minimal OAuth standalone page-state rules**

```css
body:has(.oauth-consent-shell) {
  padding-bottom: 0;
}

body:has(.oauth-consent-shell) > main {
  min-height: 100vh;
  margin-left: 0;
}
```

- [ ] **Step 4: Run focused layout and navigation tests**

Run:

```bash
pnpm exec playwright test tests/e2e/oauth-standalone-layout.spec.ts
pnpm exec vitest run apps/web/src/components/site-navigation.test.tsx apps/web/src/components/oauth-consent-panel.test.tsx apps/web/src/components/oauth-consent-form.test.tsx
```

Expected: the browser geometry test and all OAuth/navigation component tests PASS.

- [ ] **Step 5: Commit the tested layout fix**

```bash
git add apps/web/src/app/globals.css tests/e2e/oauth-standalone-layout.spec.ts
git commit -m "fix(web): center standalone OAuth consent"
```

### Task 2: Run complete local verification

**Files:**
- Modify: none
- Verify: `apps/web/src/app/globals.css`
- Verify: `tests/e2e/oauth-standalone-layout.spec.ts`

**Interfaces:**
- Consumes: the OAuth standalone page-state rules from Task 1.
- Produces: local evidence for layout geometry, navigation absence, type safety, lint, tests, and production build without changing any remote environment.

- [ ] **Step 1: Run every UI browser regression**

Run: `pnpm test:e2e:ui`

Expected: all UI Playwright specs PASS, including `1280px`, `1440px`, `1800px`, and `390px` OAuth geometry.

- [ ] **Step 2: Run repository quality gates sequentially**

Run:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
git diff --check HEAD~2 HEAD
```

Expected: every command exits `0`; existing explicitly skipped tests may remain skipped.

- [ ] **Step 3: Verify local-only delivery state**

Run:

```bash
git status --short
git log --oneline origin/main..HEAD
```

Expected: no task-related uncommitted files remain, the OAuth commits are ahead of `origin/main`, and no push or deployment command has run.
