# Attention Login Modal Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every user-initiated in-site login action use Attention's existing intercepted login modal while retaining the standalone `/login` fallback for direct loads and refreshes.

**Architecture:** A focused `LoginLink` component owns `/login` URL construction and always delegates navigation to Next.js `Link`, so in-site clicks reach the `@auth/(.)login` parallel route without a document reload. The intercepted route gains the same authenticated reauthentication branch as the standalone page; existing server redirects and post-login full refreshes remain unchanged.

**Tech Stack:** TypeScript 6, React 19, Next.js 16 App Router parallel/intercepted routes, Vitest, React server rendering.

**Spec:** `docs/superpowers/specs/2026-08-27-login-modal-navigation-design.md`

## Global Constraints

- Direct navigation or refresh of `/login` must continue to render `app/login/page.tsx` as a standalone page.
- OAuth `/auth`, server-side authentication redirects, and protected-page deep-link fallbacks remain outside this change.
- `return_to` continues through `safeReturnTo`; reauthentication email comes only from the authenticated server session.
- Post-login `window.location.assign(redirect_to)` remains a deliberate full refresh so server components observe the new session.
- Preserve all existing uncommitted admin-console work. Implementation files overlap `site-navigation.tsx`, so do not create implementation commits unless their hunks can be isolated without staging pre-existing changes.
- Do not publish or deploy.

---

### Task 1: Central login navigation primitive

**Files:**
- Create: `apps/web/src/components/login-link.tsx`
- Create: `apps/web/src/components/login-link.test.tsx`

**Interfaces:**
- Produces: `loginHref(options?: { reauthenticate?: boolean; returnTo?: string }): string`.
- Produces: `LoginLink(props: Omit<ComponentProps<typeof Link>, "href"> & { reauthenticate?: boolean; returnTo?: string }): ReactElement`.
- Default target: `/ai`; query ordering is `return_to` followed by optional `reauth=1`.

- [ ] **Step 1: Write the failing URL and component tests**

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LoginLink, loginHref } from "./login-link";

describe("login navigation", () => {
  it("builds one canonical login URL for normal and reauthentication flows", () => {
    expect(loginHref({ returnTo: "/collect" })).toBe(
      "/login?return_to=%2Fcollect",
    );
    expect(
      loginHref({
        reauthenticate: true,
        returnTo: "/account/security?edit=1",
      }),
    ).toBe(
      "/login?return_to=%2Faccount%2Fsecurity%3Fedit%3D1&reauth=1",
    );
  });

  it("renders a Next login link with the canonical target", () => {
    const markup = renderToStaticMarkup(
      <LoginLink className="button" returnTo="/collect">
        登录后收藏
      </LoginLink>,
    );
    expect(markup).toContain('href="/login?return_to=%2Fcollect"');
    expect(markup).toContain(">登录后收藏</a>");
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
pnpm exec vitest run apps/web/src/components/login-link.test.tsx
```

Expected: FAIL because `./login-link` does not exist.

- [ ] **Step 3: Implement the minimal primitive**

```tsx
import Link from "next/link";
import type { ComponentProps } from "react";

export interface LoginHrefOptions {
  reauthenticate?: boolean;
  returnTo?: string;
}

export function loginHref({
  reauthenticate = false,
  returnTo = "/ai",
}: LoginHrefOptions = {}): string {
  const search = new URLSearchParams({ return_to: returnTo });
  if (reauthenticate) search.set("reauth", "1");
  return `/login?${search.toString()}`;
}

export function LoginLink({
  reauthenticate = false,
  returnTo = "/ai",
  ...props
}: Omit<ComponentProps<typeof Link>, "href"> & LoginHrefOptions) {
  return (
    <Link
      {...props}
      href={loginHref({ reauthenticate, returnTo })}
    />
  );
}
```

- [ ] **Step 4: Run the test and verify GREEN**

Run:

```bash
pnpm exec vitest run apps/web/src/components/login-link.test.tsx
```

Expected: 2 tests pass.

---

### Task 2: Intercepted reauthentication modal

**Files:**
- Create: `apps/web/src/app/@auth/(.)login/page.test.tsx`
- Modify: `apps/web/src/app/@auth/(.)login/page.tsx`

**Interfaces:**
- Consumes: `safeReturnTo`, `getPagePrincipal`, `AuthModal`, and `LoginModule`.
- Produces: intercepted page support for `searchParams: Promise<{ reauth?: string; return_to?: string }>`.

- [ ] **Step 1: Write failing route-presentation tests**

Mock only the session boundary and Next redirect. Call the real async page component and inspect the real `LoginModule` element returned inside `AuthModal`.

```tsx
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPagePrincipal: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("../../../server/session", () => ({
  getPagePrincipal: mocks.getPagePrincipal,
}));

import InterceptedLoginPage from "./page";

describe("intercepted login", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows code-only reauthentication for the current account", async () => {
    mocks.getPagePrincipal.mockResolvedValue({
      accountId: "10000000-0000-4000-8000-000000000001",
      primaryEmail: "member@example.com",
    });
    const modal = (await InterceptedLoginPage({
      searchParams: Promise.resolve({
        reauth: "1",
        return_to: "/account/security?edit=1",
      }),
    })) as ReactElement<{ children: ReactElement }>;
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(modal.props.children.props).toMatchObject({
      defaultEmail: "member@example.com",
      forceCodeOnly: true,
      returnTo: "/account/security?edit=1",
    });
  });

  it("still redirects an authenticated ordinary login", async () => {
    mocks.getPagePrincipal.mockResolvedValue({
      accountId: "10000000-0000-4000-8000-000000000001",
      primaryEmail: "member@example.com",
    });
    await InterceptedLoginPage({
      searchParams: Promise.resolve({ return_to: "/collect" }),
    });
    expect(mocks.redirect).toHaveBeenCalledWith("/collect");
  });
});
```

- [ ] **Step 2: Run the page test and verify RED**

Run:

```bash
pnpm exec vitest run 'apps/web/src/app/@auth/(.)login/page.test.tsx'
```

Expected: reauthentication test fails because the current page redirects every authenticated principal and does not pass `forceCodeOnly`.

- [ ] **Step 3: Implement the reauthentication branch**

Parse `reauth`, redirect only for `principal && !forceReauth`, and render:

```tsx
<AuthModal>
  <LoginModule
    {...(forceReauth && principal?.primaryEmail
      ? { defaultEmail: principal.primaryEmail }
      : {})}
    forceCodeOnly={forceReauth && Boolean(principal?.primaryEmail)}
    returnTo={returnTo}
  />
</AuthModal>
```

If no principal exists, `reauth=1` renders the ordinary login module without an email or code-only flag.

- [ ] **Step 4: Run the page test and verify GREEN**

Run:

```bash
pnpm exec vitest run 'apps/web/src/app/@auth/(.)login/page.test.tsx'
```

Expected: both tests pass.

---

### Task 3: Migrate all user-initiated login actions

**Files:**
- Modify: `apps/web/src/components/collect-modal.tsx`
- Modify: `apps/web/src/app/collect/page.tsx`
- Modify: `apps/web/src/components/public-feed.tsx`
- Modify: `apps/web/src/components/membership-action.tsx`
- Modify: `apps/web/src/components/site-navigation.tsx`
- Modify: `apps/web/src/components/email-login-form.tsx`
- Modify: `apps/web/src/components/account-security-form.tsx`
- Delete: `apps/web/src/components/email-login-form.test.ts`
- Create: `apps/web/src/components/account-security-form.test.tsx`
- Create: `apps/web/src/components/login-entrypoints.test.tsx`

**Interfaces:**
- Consumes: `LoginLink` from Task 1.
- Leaves unchanged: `EmailLoginForm.completeLogin(redirectTo)` and every server-side `redirect(...)`.

- [ ] **Step 1: Write failing entrypoint tests**

For account security, render the initial password-configured state and require a reauthentication link instead of a hard-navigation button:

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AccountSecurityForm } from "./account-security-form";

describe("account security login navigation", () => {
  it("opens password reauthentication through the intercepted login route", () => {
    const markup = renderToStaticMarkup(
      <AccountSecurityForm
        email="member@example.com"
        hasPassword
      />,
    );
    expect(markup).toContain(
      'href="/login?return_to=%2Faccount%2Fsecurity%3Fedit%3D1&amp;reauth=1"',
    );
    expect(markup).toContain(">修改密码</a>");
  });
});
```

In `login-entrypoints.test.tsx`, call the real components and inspect the React element trees before rendering so a native `<a>` or generic `Link` fails the contract:

```tsx
import {
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { describe, expect, it } from "vitest";

import { CollectLoginPrompt } from "./collect-modal";
import { LoginLink } from "./login-link";
import { MembershipAction } from "./membership-action";
import { PublicFeed } from "./public-feed";

type LoginElement = ReactElement<{
  children?: ReactNode;
  returnTo?: string;
}>;

function loginLinks(node: ReactNode): LoginElement[] {
  const matches: LoginElement[] = [];
  function visit(value: ReactNode): void {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!isValidElement<{ children?: ReactNode; returnTo?: string }>(value)) {
      return;
    }
    if (value.type === LoginLink) matches.push(value);
    visit(value.props.children);
  }
  visit(node);
  return matches;
}

function expectLoginTarget(node: ReactNode, returnTo: string): void {
  const matches = loginLinks(node);
  expect(matches).toHaveLength(1);
  expect(matches[0]?.props.returnTo).toBe(returnTo);
}

describe("login entrypoints", () => {
  it("keeps the collection login action inside intercepted navigation", () => {
    expectLoginTarget(CollectLoginPrompt(), "/collect");
  });

  it("keeps the membership login action inside intercepted navigation", () => {
    expectLoginTarget(
      MembershipAction({
        isAuthenticated: false,
        isMember: false,
        providerAvailable: true,
        returnTo: "/ai",
      }),
      "/membership?return_to=%2Fai",
    );
  });

  it("keeps the public-feed paywall login inside intercepted navigation", () => {
    expectLoginTarget(
      PublicFeed({
        contents: [],
        isAuthenticated: false,
        isLimited: true,
        previewLimit: 20,
        view: "cards",
      }),
      "/membership?return_to=%2Fai",
    );
  });
});
```

Extract the hook-free exported `CollectLoginPrompt()` from `collect-modal.tsx`; `CollectModal` renders it only for unauthenticated users.

- [ ] **Step 2: Run entrypoint tests and verify RED**

Run:

```bash
pnpm exec vitest run \
  apps/web/src/components/account-security-form.test.tsx \
  apps/web/src/components/login-entrypoints.test.tsx
```

Expected: account security has no login href; membership/public-feed/collect prompt do not yet use `LoginLink`.

- [ ] **Step 3: Replace hard login navigation**

Apply these exact mappings:

- `CollectModal` and `/collect`: `<LoginLink returnTo="/collect">登录后收藏</LoginLink>`.
- `PublicFeed` unauthenticated paywall: `<LoginLink returnTo="/membership?return_to=%2Fai">登录并查看会员</LoginLink>`; authenticated membership navigation remains ordinary `Link`.
- `MembershipAction`: use `LoginLink` with `returnTo={`/membership?return_to=${encodeURIComponent(returnTo)}`}` only for unauthenticated users.
- `SiteHeader`: use `<LoginLink>登录</LoginLink>`; default return remains `/ai`.
- `AccountSecurityForm`: replace `window.location.assign('/login…')` and its handler with `<LoginLink reauthenticate returnTo="/account/security?edit=1">修改密码</LoginLink>`.
- `EmailLoginForm`: replace “忘记密码？” hard navigation with a button that clears errors and selects the existing code-login method; remove `forgotPasswordHref` because it becomes unused.
- Delete `email-login-form.test.ts`; its only contract has moved to `login-link.test.tsx`, where canonical login URL construction is now owned.

Do not replace terms/privacy external-tab anchors, checkout links, `EmailLoginForm.completeLogin`, or server redirects.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
pnpm exec vitest run \
  apps/web/src/components/login-link.test.tsx \
  'apps/web/src/app/@auth/(.)login/page.test.tsx' \
  apps/web/src/components/account-security-form.test.tsx \
  apps/web/src/components/login-entrypoints.test.tsx \
  apps/web/src/components/site-navigation.test.tsx
```

Expected: all focused login/navigation tests pass.

---

### Task 4: Regression, browser behavior, and build verification

**Files:**
- Review all files changed in Tasks 1–3.

**Interfaces:**
- Produces no new runtime interface; validates the complete navigation contract.

- [ ] **Step 1: Verify no user-initiated hard login navigation remains**

Run a review search (not a test):

```bash
rg -n 'href=.*login|window\.location\.(assign|replace).*login' \
  apps/web/src --glob '*.{ts,tsx}'
```

Expected remaining cases: server-rendered fallback links/redirect strings permitted by the spec and the deliberate post-auth `window.location.assign(redirectTo)`; no user-action `<a href="/login…">` or password-change hard navigation.

- [ ] **Step 2: Run static verification**

```bash
pnpm --filter @attention/web typecheck
pnpm exec eslint apps/web/src --ignore-pattern '.worktrees/**'
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 3: Run regression tests**

```bash
pnpm exec vitest run --maxWorkers=4
```

Expected: full suite passes with only configured conditional skips.

- [ ] **Step 4: Build the Web application**

```bash
pnpm --filter @attention/web build
```

Expected: build exits 0 and includes both `/login` and the intercepted login route behavior without route conflicts.

- [ ] **Step 5: Verify in a real browser**

With the local Web development server running, verify while logged out:

1. Open `/ai`, open the collection sheet, click “登录后收藏”, and confirm the login dialog overlays the still-present collection page.
2. Open `/membership`, click “登录后开通”, and confirm the login dialog overlays the membership page.
3. Open the password login mode, click “忘记密码？”, and confirm the same modal switches to code login without a document navigation.
4. Directly load `/login?return_to=%2Fcollect` in a new tab and confirm the standalone login page still renders.

- [ ] **Step 6: Report status without publishing**

Report files changed, focused/full verification, direct-load fallback behavior, and any unrelated pre-existing failures. Do not push, publish, or deploy.
