# OAuth Connection Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every OAuth grant a durable, uniquely named logical connection, show reliable device names when available, and replace or revoke connections without producing ambiguous duplicates.

**Architecture:** Add an `oauth_connections` layer between registered public clients and rotating tokens. Authorization carries a validated connection label and optional replacement target into the code exchange transaction; tokens reference the resulting connection. Attention Runtime supplies an opaque installation identity and display-only device name, while generic MCP clients are named by the user on the consent page.

**Tech Stack:** TypeScript 6, Next.js App Router, React, Drizzle ORM, PostgreSQL 17, OAuth Authorization Code + PKCE, Vitest, Playwright.

## Global Constraints

- The authorization page always has exactly two actions: the primary action and `取消授权`.
- A unique name uses primary copy `继续`; a duplicate name uses `继续并替换`.
- Editing the name triggers debounced validation; submission and token exchange revalidate server-side.
- User-entered duplicate names are never silently numbered.
- Replacement revokes the old connection only inside the successful token-exchange transaction.
- Generic clients are never merged or revoked by IP, User-Agent, client name, redirect URI, or scopes.
- Device names are display metadata only; no hardware serial, MAC address, disk identifier, iLink identifier, message, URL, OAuth token, or Agent thread ID is stored.
- Runtime OAuth never appears in the MCP OAuth list.
- UI reuses current Attention page width, background, spacing, typography, borders, radii, buttons, inputs, modal, focus, and error styles.
- Desktop and 390px layouts must not introduce document-level horizontal scrolling.

---

## File Map

- `packages/db/src/schema.ts`: defines logical OAuth connections and token/code references.
- `packages/db/drizzle/0028_oauth_connection_identity.sql`: creates/backfills connections and unique active-name enforcement.
- `packages/db/drizzle/meta/0028_snapshot.json`: generated Drizzle schema snapshot.
- `packages/db/drizzle/meta/_journal.json`: records migration 0028.
- `packages/auth/src/oauth-connection.ts`: normalizes labels, classifies connection kind, and resolves name availability.
- `packages/auth/src/oauth.ts`: carries connection intent through authorization code creation, token exchange, rotation, resolution, and revocation.
- `apps/web/src/app/oauth/register/route.ts`: accepts restricted Attention DCR device metadata.
- `apps/cli/src/runtime-oauth.ts`: sends stable installation identity and sanitized device name for Runtime DCR.
- `apps/web/src/app/api/oauth/connection-name/route.ts`: session-authenticated debounced name availability endpoint.
- `apps/web/src/components/oauth-authorization-form.tsx`: two-button authorization form, live name validation, and replacement confirmation.
- `apps/web/src/app/oauth/authorize/page.tsx`: projects the validated OAuth request into the client form.
- `apps/web/src/app/oauth/authorize/confirm/route.ts`: validates label/replacement and creates the pending authorization code.
- `apps/web/src/server/account.ts`: projects logical MCP connections separately from Runtime installations.
- `apps/web/src/components/connection-manager.tsx`: grouped MCP connection management and bulk revoke.
- `apps/web/src/app/api/account/oauth/[connectionId]/route.ts`: revokes one logical connection.
- `apps/web/src/app/api/account/oauth/group/route.ts`: revokes one confirmed MCP client group.
- `apps/web/src/app/globals.css`: only the minimum selectors needed to compose existing Attention design tokens.

---

### Task 1: Persist Logical OAuth Connections

**Files:**
- Modify: `packages/db/src/schema.ts:928-1040`
- Create: `packages/db/drizzle/0028_oauth_connection_identity.sql`
- Create: `packages/db/drizzle/meta/0028_snapshot.json`
- Modify: `packages/db/drizzle/meta/_journal.json`
- Test: `tests/migration-snapshot.test.ts`
- Test: `tests/integration/db-auth.test.ts`

**Interfaces:**
- Produces: `oauthConnections`, `oauthConnectionKindEnum`, and nullable `connectionId` foreign keys on authorization codes/access tokens/refresh tokens.
- Produces database invariant: one active `(account_id, audience, normalized_label)`.

- [ ] **Step 1: Write failing schema and migration tests**

Add assertions that the schema exports `oauthConnections`, tokens reference `connectionId`, and the migration contains a partial unique index:

```ts
expect(schema.oauthConnections).toBeDefined();
expect(migration).toContain("oauth_connections_active_name_unique");
expect(migration).toContain("WHERE \"revoked_at\" IS NULL");
```

Add a PostgreSQL integration test that inserts two active names differing only by case/outer whitespace and expects SQLSTATE `23505` for the second row.

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
./node_modules/.bin/vitest run tests/migration-snapshot.test.ts tests/integration/db-auth.test.ts -t "OAuth connection"
```

Expected: FAIL because `oauth_connections` and migration 0028 do not exist.

- [ ] **Step 3: Add the schema**

Define:

```ts
export const oauthConnectionKindEnum = pgEnum("oauth_connection_kind", ["mcp", "runtime"]);

export const oauthConnections = pgTable("oauth_connections", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
  clientId: varchar("client_id", { length: 128 }).notNull().references(() => oauthClients.clientId),
  audience: varchar("audience", { length: 128 }).notNull(),
  kind: oauthConnectionKindEnum("kind").notNull(),
  label: varchar("label", { length: 80 }).notNull(),
  normalizedLabel: varchar("normalized_label", { length: 80 }).notNull(),
  deviceName: varchar("device_name", { length: 80 }),
  installationKeyHash: char("installation_key_hash", { length: 64 }),
  lastAuthorizedAt: timestamp("last_authorized_at", { withTimezone: true }).notNull(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
```

Add nullable `connectionId` to existing code/token tables for a safe backfill, then make it non-null at the end of the migration.

- [ ] **Step 4: Generate and complete migration 0028**

Run `pnpm db:generate`, then edit the generated SQL with `apply_patch` to:

1. create one connection per existing `(account_id, client_id, audience)`;
2. retain the earliest client name in each duplicate-name group;
3. assign later historical collisions `client name · YYYY-MM-DD HH24:MI · <client-id-prefix>`;
4. set all code/token `connection_id` values;
5. make foreign keys non-null;
6. add the partial unique index on active normalized names.

Use a window function ordered by the earliest token/code creation time so the backfill is deterministic.

- [ ] **Step 5: Run migration tests to verify GREEN**

Run:

```bash
./node_modules/.bin/vitest run tests/migration-snapshot.test.ts tests/integration/db-auth.test.ts -t "OAuth connection"
pnpm --filter @attention/db typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit Task 1**

```bash
git add packages/db/src/schema.ts packages/db/drizzle tests/migration-snapshot.test.ts tests/integration/db-auth.test.ts
git commit -m "feat: persist logical oauth connections"
```

---

### Task 2: Carry Connection Identity Through OAuth Transactions

**Files:**
- Create: `packages/auth/src/oauth-connection.ts`
- Create: `packages/auth/src/oauth-connection.test.ts`
- Modify: `packages/auth/src/oauth.ts:160-620`
- Modify: `packages/auth/src/oauth.test.ts`
- Modify: `packages/auth/src/index.ts`

**Interfaces:**
- Produces: `normalizeOAuthConnectionLabel(value: string): { label: string; normalizedLabel: string }`.
- Produces: `checkOAuthConnectionName(db, input): Promise<OAuthConnectionNameResult>`.
- Changes: `createAuthorizationCode(..., intent: OAuthConnectionIntent)` and token pairs carry one `connectionId`.
- Changes: `revokeOAuthConnection(db, accountId, connectionId)` replaces client-ID scoped revocation for user settings.

- [ ] **Step 1: Write failing label tests**

Cover NFKC, whitespace collapse, case-insensitive uniqueness, 1–80 visible characters, and control-character rejection:

```ts
expect(normalizeOAuthConnectionLabel("  Office   MacBook  ")).toEqual({
  label: "Office MacBook",
  normalizedLabel: "office macbook",
});
expect(() => normalizeOAuthConnectionLabel("bad\u0000name")).toThrowError("invalid_connection_label");
```

- [ ] **Step 2: Write failing transaction tests**

Add tests proving:

- refresh rotation keeps the same `connectionId`;
- a normal exchange creates one connection and token pair;
- replacement exchange locks/revalidates the old connection, issues the new pair, then revokes old tokens atomically;
- an injected token insert failure rolls back the old connection revocation;
- replacement cannot target another account, audience, or normalized label;
- two concurrent same-name confirms produce one success and one name conflict.

- [ ] **Step 3: Run tests to verify RED**

```bash
./node_modules/.bin/vitest run packages/auth/src/oauth-connection.test.ts packages/auth/src/oauth.test.ts
```

Expected: FAIL with missing connection helpers/fields.

- [ ] **Step 4: Implement normalization and availability lookup**

Return one of:

```ts
type OAuthConnectionNameResult =
  | { status: "available"; label: string; normalizedLabel: string }
  | {
      status: "replaceable";
      label: string;
      normalizedLabel: string;
      existing: { connectionId: string; clientName: string; createdAt: Date; lastUsedAt: Date | null };
    };
```

The query is always constrained by `accountId`, `audience`, and `revokedAt IS NULL`.

- [ ] **Step 5: Implement atomic issue/replace/rotate**

Store `connectionLabel` and optional `replacementConnectionId` on the authorization code. During exchange:

1. lock and consume the authorization code;
2. lock a replacement connection when requested;
3. revalidate account/audience/normalized label;
4. revoke the old connection/tokens only inside the transaction;
5. create the new connection and token pair;
6. let any failure roll back the transaction.

Refresh rotation reads the old token's `connectionId` and passes it unchanged to `issueTokenPair`.

- [ ] **Step 6: Run tests and typecheck**

```bash
./node_modules/.bin/vitest run packages/auth/src/oauth-connection.test.ts packages/auth/src/oauth.test.ts
pnpm --filter @attention/auth typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit Task 2**

```bash
git add packages/auth/src
git commit -m "feat: make oauth grants connection-aware"
```

---

### Task 3: Register Reliable Runtime Device Metadata

**Files:**
- Modify: `packages/db/src/schema.ts` if DCR metadata fields are not already included in Task 1
- Modify: `packages/auth/src/oauth.ts`
- Modify: `apps/web/src/app/oauth/register/route.ts`
- Modify: `apps/web/src/app/oauth/register/route.test.ts`
- Modify: `apps/cli/src/runtime-oauth.ts`
- Modify: `apps/cli/src/runtime-oauth.test.ts`
- Modify: `apps/cli/src/channel/channel-command.ts`

**Interfaces:**
- DCR accepts optional `attention_connection_kind`, `attention_installation_id`, and `attention_device_name` only for exact Runtime scope/resource metadata.
- `authorizeRuntime()` receives `{ installationId: string; deviceName: string }`.

- [ ] **Step 1: Write failing DCR validation tests**

Prove that exact Runtime registration persists a hashed UUID and sanitized name, while MCP registration, mixed scopes, invalid UUIDs, control characters, or device names over 80 characters reject or discard the extension.

- [ ] **Step 2: Write failing CLI metadata tests**

Assert the registration body includes:

```ts
expect(body).toMatchObject({
  attention_connection_kind: "runtime",
  attention_installation_id: installationId,
  attention_device_name: "Ethan MacBook Pro",
});
```

and never includes MAC/hardware identifiers.

- [ ] **Step 3: Run tests to verify RED**

```bash
./node_modules/.bin/vitest run apps/web/src/app/oauth/register/route.test.ts apps/cli/src/runtime-oauth.test.ts
```

- [ ] **Step 4: Implement restricted metadata handling**

Extend the registration body schema, validate the Runtime audience by its exact four scopes, hash the UUID using the existing HMAC/opaque-token hashing boundary, and persist only the hash plus sanitized display name. Generic public clients remain valid without metadata.

Load the existing channel installation ID before calling `authorizeRuntime`; use the current `hostname()` result only as a default display name.

- [ ] **Step 5: Verify and commit**

```bash
./node_modules/.bin/vitest run apps/web/src/app/oauth/register/route.test.ts apps/cli/src/runtime-oauth.test.ts apps/cli/src/channel/channel-command.test.ts
pnpm --filter @attention/cli typecheck
pnpm --filter @attention/web typecheck
git add apps/cli/src apps/web/src/app/oauth/register packages/auth/src packages/db/src/schema.ts
git commit -m "feat: identify attention runtime devices"
```

---

### Task 4: Build the Two-Button Authorization Experience

**Files:**
- Create: `apps/web/src/app/api/oauth/connection-name/route.ts`
- Create: `apps/web/src/app/api/oauth/connection-name/route.test.ts`
- Create: `apps/web/src/components/oauth-authorization-form.tsx`
- Create: `apps/web/src/components/oauth-authorization-form.test.tsx`
- Modify: `apps/web/src/app/oauth/authorize/page.tsx`
- Modify: `apps/web/src/app/oauth/authorize/confirm/route.ts`
- Create: `apps/web/src/app/oauth/authorize/confirm/route.test.ts`
- Modify: `apps/web/src/app/globals.css`

**Interfaces:**
- `POST /api/oauth/connection-name` accepts `{ client_id, label, resource }` and returns the availability union without exposing other accounts.
- The confirm route accepts `connection_label` and optional `replacement_connection_id`.

- [ ] **Step 1: Write failing API tests**

Cover authentication required, available name, replaceable same-account name, no cross-account disclosure, invalid label, invalid resource, and no-store response headers.

- [ ] **Step 2: Write failing component tests**

Use fake timers to prove:

- initial default label is checked;
- edits debounce by 350ms and abort stale requests;
- pending validation disables the primary button;
- available state renders exactly `继续` and `取消授权`;
- duplicate state renders exactly `继续并替换` and `取消授权`;
- changing a duplicate to a unique name removes the old summary and changes the primary copy;
- replacement opens the existing-style confirmation modal before form submission.

- [ ] **Step 3: Run tests to verify RED**

```bash
./node_modules/.bin/vitest run apps/web/src/app/api/oauth/connection-name/route.test.ts apps/web/src/components/oauth-authorization-form.test.tsx apps/web/src/app/oauth/authorize/confirm/route.test.ts
```

- [ ] **Step 4: Implement the endpoint and client form**

Keep exactly one primary submit button and one cancel anchor. Use `AbortController`, a 350ms timer, `aria-live` for validation state, `role="alert"` for errors, and preserve the typed value on all failures.

Reuse `button`, `button--primary`, `button--secondary`, `collect-modal`, and existing input/error selectors. Add only narrowly scoped OAuth layout selectors.

- [ ] **Step 5: Implement server confirmation**

Revalidate the full OAuth request and connection label. If a replacement is supplied, validate it again but defer revocation to code exchange. On a concurrent unique-index conflict, return the authorization page's recoverable name-conflict state rather than a generic server error.

- [ ] **Step 6: Verify desktop/mobile behavior**

```bash
./node_modules/.bin/vitest run apps/web/src/app/api/oauth/connection-name/route.test.ts apps/web/src/components/oauth-authorization-form.test.tsx apps/web/src/app/oauth/authorize/confirm/route.test.ts
pnpm --filter @attention/web typecheck
pnpm --filter @attention/web build
```

Run Playwright at 1440px and 390px, asserting two actions only and `document.documentElement.scrollWidth === document.documentElement.clientWidth`.

- [ ] **Step 7: Commit Task 4**

```bash
git add apps/web/src/app/oauth apps/web/src/app/api/oauth apps/web/src/components/oauth-authorization-form* apps/web/src/app/globals.css
git commit -m "feat: name and replace oauth authorizations"
```

---

### Task 5: Project and Revoke Connections by Logical Identity

**Files:**
- Modify: `apps/web/src/server/account.ts`
- Modify: `apps/web/src/server/account-connections.test.ts`
- Modify: `apps/web/src/components/connection-manager.tsx`
- Modify: `apps/web/src/components/connection-manager.test.ts`
- Modify: `apps/web/src/app/api/account/oauth/[clientId]/route.ts` and rename parameter semantics to `connectionId`
- Create: `apps/web/src/app/api/account/oauth/group/route.ts`
- Create: `apps/web/src/app/api/account/oauth/group/route.test.ts`
- Modify: `apps/web/src/app/globals.css`

**Interfaces:**
- `loadConnectionOverview()` returns grouped `mcpOAuthConnections` and never returns Runtime token rows in that collection.
- Single revoke takes `connectionId`; group revoke takes `{ clientName }` and server-fixes audience to `attention-mcp`.

- [ ] **Step 1: Write failing projection tests**

Fixture three Codex MCP connections and two Runtime connections. Assert one Codex group with three uniquely labeled children, zero Runtime rows in the OAuth list, and Runtime installation status still present separately.

- [ ] **Step 2: Write failing revoke tests**

Prove single revoke is account-owned and connection-scoped. Prove group revoke cannot accept an account ID or audience and revokes only the current account's MCP connections matching the normalized client name.

- [ ] **Step 3: Write failing UI tests**

Assert group summary copy `Codex · 3 个连接`, collapsed scopes, expansion, individual revoke, bulk confirmation count, and no Runtime OAuth card.

- [ ] **Step 4: Run tests to verify RED**

```bash
./node_modules/.bin/vitest run apps/web/src/server/account-connections.test.ts apps/web/src/components/connection-manager.test.ts apps/web/src/app/api/account/oauth/group/route.test.ts
```

- [ ] **Step 5: Implement projection, UI, and revocation**

Use the logical connection rows, not active refresh-token rows, as the settings source of truth. Derive recent use from `oauth_connections.last_used_at`; update it when an access token is successfully resolved, with the existing bounded write cadence used for token auditing.

Reuse existing connection cards and modal styles; scope details are collapsed by default.

- [ ] **Step 6: Verify and commit**

```bash
./node_modules/.bin/vitest run apps/web/src/server/account-connections.test.ts apps/web/src/components/connection-manager.test.ts apps/web/src/app/api/account/oauth/group/route.test.ts
pnpm --filter @attention/web typecheck
git add apps/web/src/server/account* apps/web/src/components/connection-manager* apps/web/src/app/api/account/oauth apps/web/src/app/globals.css
git commit -m "fix: present oauth connections without duplicates"
```

---

### Task 6: Full OAuth, Migration, and Visual Acceptance

**Files:**
- Modify only failing implementation/tests from Tasks 1–5.
- Update: `docs/superpowers/specs/2026-08-11-oauth-connection-identity-design.md` only if implementation reveals a contradiction; do not weaken requirements silently.

**Interfaces:**
- Consumes all Task 1–5 interfaces.
- Produces release-ready evidence for migration, OAuth, Runtime and settings UI.

- [ ] **Step 1: Run focused suites**

```bash
./node_modules/.bin/vitest run packages/auth/src/oauth.test.ts packages/auth/src/oauth-connection.test.ts apps/web/src/app/oauth apps/web/src/app/api/oauth apps/web/src/server/account-connections.test.ts apps/web/src/components/connection-manager.test.ts apps/cli/src/runtime-oauth.test.ts tests/migration-snapshot.test.ts tests/integration/db-auth.test.ts
```

- [ ] **Step 2: Run repository gates**

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
git diff --check
```

- [ ] **Step 3: Run real PostgreSQL migration acceptance**

Against an isolated PostgreSQL 17 database, seed historical Codex and Runtime tokens with duplicate names, run migrations through 0028, and assert:

- all active tokens reference one logical connection;
- migrated labels are deterministic and unique;
- no token is silently revoked;
- the active-name unique index rejects a duplicate;
- down-stream runtime/account queries still work.

- [ ] **Step 4: Run browser OAuth acceptance**

With a real authenticated local web session and PKCE callback fixture:

1. authorize `Codex` as `办公室 MacBook`;
2. start a second authorization with the same label;
3. edit to a unique label and verify `继续`;
4. return to the duplicate label and verify `继续并替换`;
5. cancel and prove the original token remains valid;
6. repeat and replace, proving the new token works and original refresh/access tokens fail;
7. verify desktop and 390px screenshots match current Attention styling.

- [ ] **Step 5: Close verification findings**

If a gate fails, return the fix to the task that owns the affected file, add a regression test there,
and amend that task's explicit commit only after its focused suite is green. Rerun Steps 1–4 after
every fix. If all gates pass without source changes, do not create an empty verification commit.
