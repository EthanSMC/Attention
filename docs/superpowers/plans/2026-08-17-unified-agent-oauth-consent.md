# Unified Agent OAuth Consent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every Agent, Sync, and local Runtime OAuth consent flow with one user-readable authorization experience, automatic collision-safe connection naming, and later inline renaming from Connections & Authorization.

**Architecture:** A pure shared presentation module converts validated audiences/scopes into permission groups and data-range copy. The consent route renders that model through a standalone panel and submits only the protocol fields needed by the server; connection names are allocated transactionally at token materialization. Account settings reuse the presentation vocabulary, expose all OAuth audiences, and add a same-account rename endpoint.

**Tech Stack:** Next.js App Router, React 19, TypeScript 6, Drizzle/PostgreSQL, Zod, Vitest, existing Attention design tokens and session/API guards.

## Global Constraints

- Cover `attention-mcp`, `attention-sync`, and `attention-channel-runtime` with one consent shell.
- Visible heading copy is `“{clientName} 想要访问你的 Attention”`.
- Never show logos, initials, avatars, verification badges, callback hosts, redirect URIs, resource identifiers, raw OAuth scopes, PKCE terminology, or a connection-name field in the UI.
- Hidden protocol form fields may retain validated OAuth values; they must never appear as visible text.
- Visible permission and data copy must be derived only from the validated requested scopes; unmapped scopes fail closed with no allow action.
- Final actions are exactly `允许并连接` and `拒绝`.
- State explicitly that the Attention login Session is not given to the client, link to `/account/connections` for revocation, and link to `/privacy`.
- Generic MCP/Sync connections use client-name labels with numeric collision suffixes; they never replace an existing connection because of a name collision.
- Runtime initial labels use trusted device names; reauthorization preserves a later user rename while rotating the same installation connection.
- Rename changes only the user label and normalized label.
- Maintain WCAG 2.2 AA, 44px controls, keyboard behavior, live pending/error states, and the current no-decorative-motion product register.
- Follow red-green-refactor for every production behavior and stage only files named by the current task when committing in the dirty worktree.

---

## File Map

**Create**

- `apps/web/src/lib/oauth-consent-presentation.ts` — exhaustive audience/scope-to-copy mapping.
- `apps/web/src/lib/oauth-consent-presentation.test.ts` — pure mapping and fail-closed tests.
- `apps/web/src/components/oauth-consent-panel.tsx` — visible consent content and information order.
- `apps/web/src/components/oauth-consent-panel.test.tsx` — rendered-copy and no-visible-technical-detail tests.
- `apps/web/src/components/oauth-consent-form.tsx` — guarded allow/refuse form with pending announcement.
- `apps/web/src/components/oauth-consent-form.test.tsx` — exact actions and submission guard tests.
- `apps/web/src/components/site-navigation.test.tsx` — standalone OAuth chrome tests.

**Modify**

- `apps/web/src/app/oauth/authorize/page.tsx` — validate, build presentation, render consent panel, and simplify invalid-request copy.
- `apps/web/src/app/oauth/authorize/confirm/handler.ts` — issue automatic-label authorization codes without connection-name validation/replacement.
- `apps/web/src/app/oauth/authorize/confirm/route.test.ts` — automatic intent and revalidation tests.
- `apps/web/src/components/site-navigation.tsx` — hide header/FAB/mobile navigation on `/oauth/*`.
- `apps/web/src/app/globals.css` — consent layout, permission groups, assurances, responsive actions, and removal of obsolete authorization styles.
- `packages/auth/src/oauth-connection.ts` — automatic candidate generation and rename operation.
- `packages/auth/src/oauth-connection.test.ts` — suffix/truncation/rename tests.
- `packages/auth/src/oauth.ts` — optional-label authorization codes, collision-safe materialization, Runtime rename preservation.
- `packages/auth/src/oauth.test.ts` — token-exchange naming, concurrency, compatibility, and Runtime rotation tests.
- `apps/web/src/server/account.ts` — project active OAuth connections for all three audiences with audience/device metadata.
- `apps/web/src/server/account-connections.test.ts` — projection coverage for MCP, Sync, and Runtime.
- `apps/web/src/components/connection-manager.tsx` — user-readable permissions and inline rename UI.
- `apps/web/src/components/connection-manager.test.ts` — rename request/outcome and permission-copy tests.
- `apps/web/src/app/account/connections/page.tsx` — serialize the expanded connection projection.
- `apps/web/src/app/api/account/oauth/[connectionId]/route.ts` — add guarded PATCH rename next to DELETE revoke.
- `apps/web/src/app/api/account/oauth/[connectionId]/route.test.ts` — rename auth, validation, conflict, and not-found tests.
- `apps/web/src/app/privacy/page.tsx` — third-party OAuth data/responsibility/revocation language.

**Remove after replacement tests pass**

- `apps/web/src/components/oauth-authorization-form.tsx`
- `apps/web/src/components/oauth-authorization-form.test.tsx`

---

### Task 1: Build the Exhaustive Consent Presentation Model

**Files:**
- Create: `apps/web/src/lib/oauth-consent-presentation.ts`
- Create: `apps/web/src/lib/oauth-consent-presentation.test.ts`

**Interfaces:**
- Consumes: type-only `OAuthAudience` and `OAuthScope` imports from `@attention/auth`; the client-safe production module does not import the server auth package at runtime. Tests use `oauthScopesByAudience` to prove exhaustive coverage.
- Produces:

```ts
export interface OAuthPermissionGroup {
  id: string;
  title: string;
  description: string;
  risk: "standard" | "write" | "irreversible";
}

export interface OAuthConsentPresentation {
  audienceSummary: string;
  dataItems: string[];
  permissionGroups: OAuthPermissionGroup[];
}

export class OAuthConsentPresentationError extends Error {}

export function buildOAuthConsentPresentation(
  audience: OAuthAudience,
  scopes: readonly OAuthScope[],
): OAuthConsentPresentation;
```

- [ ] **Step 1: Write failing mapping tests**

```ts
import {
  oauthScopesByAudience,
  type OAuthAudience,
} from "@attention/auth";
import { describe, expect, it } from "vitest";
import {
  buildOAuthConsentPresentation,
  OAuthConsentPresentationError,
} from "./oauth-consent-presentation";

describe.each(Object.entries(oauthScopesByAudience) as Array<
  [OAuthAudience, readonly string[]]
>)("OAuth consent presentation for %s", (audience, scopes) => {
  it("covers every supported scope without exposing protocol names", () => {
    const presentation = buildOAuthConsentPresentation(audience, scopes as never);
    expect(presentation.permissionGroups.length).toBeGreaterThan(0);
    const visibleCopy = JSON.stringify(presentation);
    for (const scope of scopes) expect(visibleCopy).not.toContain(scope);
  });
});

it("shows irreversible voting language only for vote access", () => {
  const withoutVote = buildOAuthConsentPresentation("attention-mcp", ["moderation:court:read"]);
  const withVote = buildOAuthConsentPresentation("attention-mcp", ["moderation:court:vote"]);
  expect(JSON.stringify(withoutVote)).not.toContain("不可更改");
  expect(JSON.stringify(withVote)).toContain("不可更改");
});

it("fails closed when a scope is not mapped", () => {
  expect(() => buildOAuthConsentPresentation(
    "attention-mcp",
    ["unknown:scope" as never],
  )).toThrow(OAuthConsentPresentationError);
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `pnpm exec vitest run apps/web/src/lib/oauth-consent-presentation.test.ts`

Expected: FAIL because `oauth-consent-presentation.ts` does not exist.

- [ ] **Step 3: Implement the pure mapping**

Define ordered group descriptors with explicit scope membership, copy builders for read-only versus read/write Digest and Sync requests, deduplicated data-item IDs, and an exhaustive postcondition:

```ts
const requested = new Set(scopes);
const covered = new Set<OAuthScope>();
const permissionGroups = descriptors[audience].flatMap((descriptor) => {
  const matching = descriptor.scopes.filter((scope) => requested.has(scope));
  if (!matching.length) return [];
  matching.forEach((scope) => covered.add(scope));
  return [descriptor.present(requested)];
});
if (covered.size !== requested.size || scopes.some((scope) => !covered.has(scope))) {
  throw new OAuthConsentPresentationError("unmapped_oauth_scope");
}
```

Use the exact group titles from the design spec: `查看账号与私人收藏`, `新增私人收藏`, `查看和修改日报`, `使用公开内容与 AI 检索`, `参与公开治理`, `同步你的私人收藏`, `连接本地 Agent`, `上报运行状态`, and `同步渠道连接状态`.

- [ ] **Step 4: Run presentation tests and verify GREEN**

Run: `pnpm exec vitest run apps/web/src/lib/oauth-consent-presentation.test.ts`

Expected: all presentation tests PASS with no warnings.

- [ ] **Step 5: Commit the isolated model**

```bash
git add apps/web/src/lib/oauth-consent-presentation.ts apps/web/src/lib/oauth-consent-presentation.test.ts
git commit -m "feat: add oauth consent presentation model"
```

---

### Task 2: Render the Standalone Robinhood-Style Consent Surface

**Files:**
- Create: `apps/web/src/components/oauth-consent-panel.tsx`
- Create: `apps/web/src/components/oauth-consent-panel.test.tsx`
- Create: `apps/web/src/components/oauth-consent-form.tsx`
- Create: `apps/web/src/components/oauth-consent-form.test.tsx`
- Create: `apps/web/src/components/site-navigation.test.tsx`
- Modify: `apps/web/src/app/oauth/authorize/page.tsx`
- Modify: `apps/web/src/components/site-navigation.tsx`
- Modify: `apps/web/src/app/globals.css`
- Remove: `apps/web/src/components/oauth-authorization-form.tsx`
- Remove: `apps/web/src/components/oauth-authorization-form.test.tsx`

**Interfaces:**
- Consumes: `OAuthConsentPresentation` and existing hidden authorization fields.
- Produces:

```ts
export interface OAuthConsentFields {
  client_id: string;
  code_challenge: string;
  code_challenge_method: "S256";
  redirect_uri: string;
  resource: string;
  response_type: "code";
  scope: string;
  state?: string;
}

export function OAuthConsentPanel(props: {
  accountLabel: string;
  cancelHref: string;
  clientName: string;
  fields: OAuthConsentFields;
  presentation: OAuthConsentPresentation;
}): React.ReactNode;
```

- [ ] **Step 1: Write failing visible-content tests**

Render the panel to static markup and assert exact visible labels. Technical values may exist only inside hidden input attributes; assert that none appear between element tags:

```ts
const markup = renderToStaticMarkup(<OAuthConsentPanel {...props} />);
expect(markup).toContain("Codex 想要访问你的 Attention");
expect(markup).toContain("授权后可能接触的数据");
expect(markup).toContain("Attention 登录 Session 不会交给 Codex");
expect(markup).toContain("允许并连接");
expect(markup).toContain("拒绝");
expect(markup).not.toContain("authorization-card__client");
expect(markup).not.toContain("connection_label");
expect(markup).not.toMatch(/>(?:profile:read|https:\/\/attention\.example\/mcp|S256)</u);
```

Add form tests that call `onSubmit` twice and prove only the first submit enters pending state, disables the primary action, and exposes `aria-busy="true"` plus `正在连接…`.

Add navigation tests with mocked `usePathname()` proving `/oauth/authorize` returns no SiteHeader, collection FAB, or MobileNavigation, while `/ai` still renders them.

- [ ] **Step 2: Run the component tests and verify RED**

Run: `pnpm exec vitest run apps/web/src/components/oauth-consent-panel.test.tsx apps/web/src/components/oauth-consent-form.test.tsx apps/web/src/components/site-navigation.test.tsx`

Expected: FAIL because the new components and standalone path behavior do not exist.

- [ ] **Step 3: Implement the panel, guarded form, route composition, and standalone chrome**

The panel order is heading → current account → permission sections → data range → Session/revocation → privacy → actions. Use semantic `<section>`, `<h2>`, `<ul>`, and links. The route catches `OAuthConsentPresentationError` and returns a generic non-authorizable state without raw error codes.

Replace `isStandaloneDocumentationPath` with:

```ts
function isStandalonePath(pathname: string): boolean {
  return pathname.startsWith("/doc") || pathname.startsWith("/oauth/");
}
```

Both `SiteHeader` and `MobileNavigation` call the same predicate before rendering.

Use `.oauth-consent`, `.oauth-consent__permissions`, `.oauth-permission`, `.oauth-consent__data`, `.oauth-consent__assurances`, and `.oauth-consent__actions` classes. Set the main container to 16px radius, flat 1px borders, no shadow, and one-column full-width actions below 600px.

- [ ] **Step 4: Run the component tests and verify GREEN**

Run: `pnpm exec vitest run apps/web/src/components/oauth-consent-panel.test.tsx apps/web/src/components/oauth-consent-form.test.tsx apps/web/src/components/site-navigation.test.tsx`

Expected: all new consent and standalone-navigation tests PASS with no warnings.

- [ ] **Step 5: Commit the standalone consent UI**

```bash
git add apps/web/src/app/oauth/authorize/page.tsx apps/web/src/app/globals.css apps/web/src/components/oauth-consent-panel.tsx apps/web/src/components/oauth-consent-panel.test.tsx apps/web/src/components/oauth-consent-form.tsx apps/web/src/components/oauth-consent-form.test.tsx apps/web/src/components/site-navigation.tsx apps/web/src/components/site-navigation.test.tsx apps/web/src/components/oauth-authorization-form.tsx apps/web/src/components/oauth-authorization-form.test.tsx
git commit -m "feat: unify agent oauth consent UI"
```

---

### Task 3: Issue Automatic-Label Authorization Codes

**Files:**
- Modify: `packages/auth/src/oauth-connection.ts`
- Modify: `packages/auth/src/oauth-connection.test.ts`
- Modify: `packages/auth/src/oauth.ts`
- Modify: `packages/auth/src/oauth.test.ts`
- Modify: `apps/web/src/app/oauth/authorize/confirm/handler.ts`
- Modify: `apps/web/src/app/oauth/authorize/confirm/route.test.ts`

**Interfaces:**
- Produces `OAuthConnectionIntent` variant `{ mode: "auto" }`.
- Produces `oauthConnectionLabelCandidate(baseLabel: string, ordinal: number): { label: string; normalizedLabel: string }`.
- Consent confirmation revalidates the OAuth request and calls `createAuthorizationCode(..., { mode: "auto" })` for every audience.

- [ ] **Step 1: Write failing candidate and confirmation tests**

```ts
expect(oauthConnectionLabelCandidate("Codex", 1).label).toBe("Codex");
expect(oauthConnectionLabelCandidate("Codex", 2).label).toBe("Codex 2");
expect([...oauthConnectionLabelCandidate("x".repeat(80), 12).label]).toHaveLength(80);
expect(oauthConnectionLabelCandidate("x".repeat(80), 12).label.endsWith(" 12")).toBe(true);
```

Update confirmation tests so the POST body has no `connection_label` or `replacement_connection_id`, `checkName` and `resolveRuntimeIntent` are absent from dependencies, and `createCode` receives `{ mode: "auto" }` after full OAuth request validation.

- [ ] **Step 2: Run targeted tests and verify RED**

Run: `pnpm exec vitest run packages/auth/src/oauth-connection.test.ts apps/web/src/app/oauth/authorize/confirm/route.test.ts`

Expected: FAIL because the auto intent and candidate function do not exist and the handler still requires a label.

- [ ] **Step 3: Implement optional-label authorization codes and simplified confirmation**

Change `createAuthorizationCode` so `mode: "auto"` stores null `connectionLabel`, null `normalizedConnectionLabel`, null replacement, and null connection ID. Existing create/replace/rotate intents continue storing their legacy fields so unexpired pre-deployment authorization codes remain compatible.

Remove connection-name checking, recoverable name redirects, and Runtime intent resolution from the confirmation handler. Keep body-size guard, same-origin mutation guard, session loading, full request revalidation, state propagation, and no-store redirect unchanged.

- [ ] **Step 4: Run candidate and confirmation tests and verify GREEN**

Run: `pnpm exec vitest run packages/auth/src/oauth-connection.test.ts apps/web/src/app/oauth/authorize/confirm/route.test.ts`

Expected: all targeted tests PASS.

- [ ] **Step 5: Commit automatic authorization intent**

```bash
git add packages/auth/src/oauth-connection.ts packages/auth/src/oauth-connection.test.ts packages/auth/src/oauth.ts packages/auth/src/oauth.test.ts apps/web/src/app/oauth/authorize/confirm/handler.ts apps/web/src/app/oauth/authorize/confirm/route.test.ts
git commit -m "feat: issue oauth grants with automatic labels"
```

---

### Task 4: Materialize Collision-Safe Labels and Preserve Runtime Renames

**Files:**
- Modify: `packages/auth/src/oauth.ts`
- Modify: `packages/auth/src/oauth.test.ts`
- Modify: `packages/auth/src/oauth-connection.ts`
- Modify: `packages/auth/src/oauth-connection.test.ts`

**Interfaces:**
- Consumes: `oauthConnectionLabelCandidate` from Task 3.
- Produces collision-safe generic connection materialization and Runtime reauthorization that preserves `oauthConnections.label`.

- [ ] **Step 1: Write failing token-exchange tests**

Add tests proving:

```ts
expect(first.connection.label).toBe("Codex");
expect(second.connection.label).toBe("Codex 2");
expect(existing.revokedAt).toBeNull();
```

Add an insertion double that returns no row for the first `onConflictDoNothing()` attempt and a row for the second, proving concurrent collision retry. Add a Runtime fixture whose trusted `deviceName` is `Ethan MacBook` and existing user label is `工作电脑`; after reauthorization, assert label remains `工作电脑`, device name remains `Ethan MacBook`, connection ID is unchanged, and previous credentials are revoked.

- [ ] **Step 2: Run token-exchange tests and verify RED**

Run: `pnpm exec vitest run packages/auth/src/oauth.test.ts -t "automatic label|preserves runtime rename|concurrent label"`

Expected: FAIL because generic auto codes still materialize `Imported connection …` and Runtime rotation resets the label.

- [ ] **Step 3: Implement collision-safe generic materialization**

During exchange, load the active client's validated name alongside Runtime metadata. For generic auto materialization, loop ordinal values starting at 1:

```ts
for (let ordinal = 1; ordinal <= 1_000; ordinal += 1) {
  const candidate = oauthConnectionLabelCandidate(clientName, ordinal);
  const [created] = await tx
    .insert(oauthConnections)
    .values({ ...connectionValues, ...candidate })
    .onConflictDoNothing()
    .returning({ id: oauthConnections.id });
  if (created) return created.id;
}
throw new OAuthError("invalid_grant");
```

For Runtime auto reauthorization, use trusted device name only when creating a new connection. When `resolveRuntimeOAuthConnectionIntent` returns `rotate`, preserve the locked existing row's label/normalized label and update only client/trusted metadata, authorization time, and credential rotation fields.

- [ ] **Step 4: Run full auth tests and verify GREEN**

Run: `pnpm exec vitest run packages/auth/src/oauth-connection.test.ts packages/auth/src/oauth.test.ts apps/web/src/app/oauth/authorize/confirm/route.test.ts`

Expected: all auth and confirmation tests PASS, including legacy stored-label authorization codes.

- [ ] **Step 5: Commit lifecycle behavior**

```bash
git add packages/auth/src/oauth.ts packages/auth/src/oauth.test.ts packages/auth/src/oauth-connection.ts packages/auth/src/oauth-connection.test.ts
git commit -m "feat: materialize collision-safe oauth connections"
```

---

### Task 5: Project and Display Every OAuth Audience Without Raw Scopes

**Files:**
- Modify: `apps/web/src/server/account.ts`
- Modify: `apps/web/src/server/account-connections.test.ts`
- Modify: `apps/web/src/app/account/connections/page.tsx`
- Modify: `apps/web/src/components/connection-manager.tsx`
- Modify: `apps/web/src/components/connection-manager.test.ts`
- Modify: `packages/auth/src/oauth.ts`
- Modify: `packages/auth/src/oauth.test.ts`
- Modify: `apps/web/src/app/api/account/oauth/group/route.ts`
- Modify: `apps/web/src/app/api/account/oauth/group/route.test.ts`

**Interfaces:**
- Replace `McpOAuthConnectionOverview` with `AgentOAuthConnectionOverview` containing `audience: OAuthAudience`, `deviceName: string | null`, and existing connection facts.
- Replace group key with `{ audience, clientName, connections }` so MCP, Sync, and Runtime cannot collapse into one ambiguous group.
- Generalize `revokeMcpOAuthConnectionSnapshot` to `revokeOAuthConnectionSnapshot` with an exact validated audience.

- [ ] **Step 1: Write failing projection and UI tests**

Update the connection database fixture with one MCP row, one Sync row, and one Runtime row. Assert all three appear in separate groups and carry their audience. Render `ConnectionManager` and assert it contains user-facing titles such as `同步你的私人收藏` and `上报运行状态`, while no visible `<code>` or raw `sync:read`/`runtime:heartbeat` text appears.

Update group-revoke tests so the body includes `audience`, and prove the auth service rejects any snapshot whose IDs do not all match account, audience, kind, active state, and normalized client group.

- [ ] **Step 2: Run settings projection tests and verify RED**

Run: `pnpm exec vitest run apps/web/src/server/account-connections.test.ts apps/web/src/components/connection-manager.test.ts apps/web/src/app/api/account/oauth/group/route.test.ts packages/auth/src/oauth.test.ts -t "snapshot"`

Expected: FAIL because the query filters to `attention-mcp`, the overview lacks audience/device metadata, and the UI renders raw scopes.

- [ ] **Step 3: Generalize projection, grouping, readable permissions, and bulk revoke**

Query active OAuth connections for the three supported audiences, retain `kind`, include `oauthConnections.deviceName`, and group by `audience + normalized client name`. Pass each connection's current stored scope source through `buildOAuthConsentPresentation` and render only `permissionGroups.map(({ title }) => title)` as a semantic list.

Generalize snapshot revoke to accept `OAuthAudience` and require every locked row and every current active group row to match that audience. Preserve snapshot-staleness semantics and exact-ID revocation.

- [ ] **Step 4: Run connection/settings tests and verify GREEN**

Run: `pnpm exec vitest run apps/web/src/server/account-connections.test.ts apps/web/src/components/connection-manager.test.ts apps/web/src/app/api/account/oauth/group/route.test.ts packages/auth/src/oauth.test.ts -t "snapshot"`

Expected: all projection, readable-permission, and snapshot tests PASS.

- [ ] **Step 5: Commit all-audience connection management**

```bash
git add apps/web/src/server/account.ts apps/web/src/server/account-connections.test.ts apps/web/src/app/account/connections/page.tsx apps/web/src/components/connection-manager.tsx apps/web/src/components/connection-manager.test.ts apps/web/src/app/api/account/oauth/group/route.ts apps/web/src/app/api/account/oauth/group/route.test.ts packages/auth/src/oauth.ts packages/auth/src/oauth.test.ts
git commit -m "feat: manage all oauth audiences consistently"
```

---

### Task 6: Add Same-Account Inline Connection Rename

**Files:**
- Modify: `packages/auth/src/oauth-connection.ts`
- Modify: `packages/auth/src/oauth-connection.test.ts`
- Modify: `apps/web/src/app/api/account/oauth/[connectionId]/route.ts`
- Modify: `apps/web/src/app/api/account/oauth/[connectionId]/route.test.ts`
- Modify: `apps/web/src/components/connection-manager.tsx`
- Modify: `apps/web/src/components/connection-manager.test.ts`
- Modify: `apps/web/src/app/globals.css`

**Interfaces:**
- Produces:

```ts
export async function renameOAuthConnection(
  db: AttentionDatabase,
  input: { accountId: string; connectionId: string; label: string },
  now?: Date,
): Promise<{ label: string; renamed: boolean }>;
```

- PATCH request body: `{ label: string }`.
- Success: HTTP 200 `{ label: string, renamed: true }`.
- Duplicate: HTTP 409 `{ error: { code: "oauth_connection_name_conflict" } }`.
- Missing/revoked/cross-account: HTTP 404 `{ error: { code: "oauth_connection_not_found" } }`.

- [ ] **Step 1: Write failing auth, route, and component tests**

Test normalization, successful same-account update, unchanged `deviceName`/`installationKeyHash`/audience/client/scopes/timestamps, duplicate conflict, and non-disclosing not-found behavior.

For the component, extract and test:

```ts
export async function requestOAuthConnectionRename(
  connectionId: string,
  label: string,
  request: typeof fetch = fetch,
): Promise<"renamed" | "conflict" | "failed" | "unknown">;
```

Assert `重命名` opens an inline labeled input with existing label, `保存` and `取消`; successful save updates the visible label and live feedback without reload; conflict preserves the typed value and shows `这个名称已被同类连接使用，请换一个名称。`.

- [ ] **Step 2: Run rename tests and verify RED**

Run: `pnpm exec vitest run packages/auth/src/oauth-connection.test.ts 'apps/web/src/app/api/account/oauth/[connectionId]/route.test.ts' apps/web/src/components/connection-manager.test.ts -t "rename|重命名"`

Expected: FAIL because PATCH, rename service, and inline UI do not exist.

- [ ] **Step 3: Implement rename service, guarded PATCH, and inline editor**

Lock the account-owned active connection, normalize the new label, return unchanged success when normalized value is identical, and update only `label`, `normalizedLabel`, and `updatedAt`. Map the existing unique-index conflict with `isOAuthConnectionNameConflict` to HTTP 409.

In the client component, keep one edit state `{ connectionId, value, error, busy }`, block duplicate submissions with a ref, and restore focus to the row's rename button after cancel or success.

- [ ] **Step 4: Run rename tests and verify GREEN**

Run: `pnpm exec vitest run packages/auth/src/oauth-connection.test.ts 'apps/web/src/app/api/account/oauth/[connectionId]/route.test.ts' apps/web/src/components/connection-manager.test.ts -t "rename|重命名"`

Expected: all rename tests PASS.

- [ ] **Step 5: Commit rename behavior**

```bash
git add packages/auth/src/oauth-connection.ts packages/auth/src/oauth-connection.test.ts 'apps/web/src/app/api/account/oauth/[connectionId]/route.ts' 'apps/web/src/app/api/account/oauth/[connectionId]/route.test.ts' apps/web/src/components/connection-manager.tsx apps/web/src/components/connection-manager.test.ts apps/web/src/app/globals.css
git commit -m "feat: rename oauth connections from settings"
```

---

### Task 7: Complete Privacy Copy and End-to-End Verification

**Files:**
- Modify: `apps/web/src/app/privacy/page.tsx`
- Test: all files touched by Tasks 1–6.

**Interfaces:**
- Produces visible section `第三方 OAuth 客户端` with the accepted data/session/revocation responsibility boundary.

- [ ] **Step 1: Write the failing privacy rendering test**

Add `apps/web/src/app/privacy/page.test.tsx` if no policy test exists:

```ts
const markup = renderToStaticMarkup(<PrivacyPage />);
expect(markup).toContain("第三方 OAuth 客户端");
expect(markup).toContain("不会获得你的 Attention 登录 Session");
expect(markup).toContain("连接与授权");
expect(markup).toContain("已经接收的数据");
```

- [ ] **Step 2: Run the privacy test and verify RED**

Run: `pnpm exec vitest run apps/web/src/app/privacy/page.test.tsx`

Expected: FAIL because the third-party OAuth section does not exist.

- [ ] **Step 3: Add precise privacy and revocation language**

State that connected clients receive only permitted data subject to current entitlement, never receive the website Session, become responsible for data after receipt, can be stopped from future access through Connections & Authorization, and may retain data already received according to their own behavior.

- [ ] **Step 4: Run focused OAuth and settings test suites**

Run:

```bash
pnpm exec vitest run \
  apps/web/src/lib/oauth-consent-presentation.test.ts \
  apps/web/src/components/oauth-consent-panel.test.tsx \
  apps/web/src/components/oauth-consent-form.test.tsx \
  apps/web/src/components/site-navigation.test.tsx \
  apps/web/src/app/oauth/authorize/confirm/route.test.ts \
  packages/auth/src/oauth-connection.test.ts \
  packages/auth/src/oauth.test.ts \
  apps/web/src/server/account-connections.test.ts \
  apps/web/src/components/connection-manager.test.ts \
  'apps/web/src/app/api/account/oauth/[connectionId]/route.test.ts' \
  apps/web/src/app/api/account/oauth/group/route.test.ts \
  apps/web/src/app/privacy/page.test.tsx
```

Expected: all focused tests PASS with zero failures.

- [ ] **Step 5: Run static and production verification**

Run: `pnpm typecheck`

Expected: exit 0.

Run: `pnpm exec eslint apps/web/src/app/oauth apps/web/src/app/account/connections apps/web/src/app/api/account/oauth apps/web/src/components/oauth-consent-panel.tsx apps/web/src/components/oauth-consent-form.tsx apps/web/src/components/connection-manager.tsx apps/web/src/components/site-navigation.tsx apps/web/src/lib/oauth-consent-presentation.ts apps/web/src/server/account.ts apps/web/src/app/privacy packages/auth/src/oauth.ts packages/auth/src/oauth-connection.ts`

Expected: exit 0 with no lint errors.

Run: `pnpm --filter @attention/web build`

Expected: production Next.js build exits 0.

Run: `git diff --check`

Expected: no whitespace errors.

- [ ] **Step 6: Run proportional visual verification**

If the local database has current migrations and representative OAuth clients, render MCP, Sync, and Runtime consent requests at desktop and 390px mobile widths. Verify information order, no product chrome, no visible technical fields, keyboard focus, stacked actions, and long Chinese copy wrapping.

If the database is unavailable or stale, record the exact blocker and use component-rendered markup plus build/test evidence. Do not claim a full browser pass from the generic `invalid_request` fallback page.

- [ ] **Step 7: Commit privacy and final verification changes**

```bash
git add apps/web/src/app/privacy/page.tsx apps/web/src/app/privacy/page.test.tsx
git commit -m "docs: clarify oauth privacy boundaries"
```

---

## Completion Checklist

- [ ] All three audiences render through the same consent presentation API.
- [ ] No visible technical OAuth identifiers or connection-name input remain.
- [ ] Generic names suffix without replacement, including concurrent collisions.
- [ ] Runtime reauthorization preserves user labels and rotates the same installation.
- [ ] Connections & Authorization shows all audiences, uses user language, and supports rename/revoke.
- [ ] Privacy copy states data, Session, responsibility, and revocation boundaries.
- [ ] Focused tests, typecheck, lint, build, and `git diff --check` have fresh passing evidence.
- [ ] Browser verification is either completed for representative flows or reported with the exact environmental blocker.
