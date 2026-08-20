# Channel Session Takeover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the newest WeChat QR-login session atomically replace any older Runtime binding, prevent replaced sessions from reclaiming ownership, and publish only CLI `0.3.8`.

**Architecture:** CLI `0.3.8` hashes the local iLink token into a non-secret session fingerprint and includes it in binding reports. A narrowly scoped PostgreSQL `SECURITY DEFINER` function serializes ownership changes across account RLS, tombstones old sessions, and returns only a stable outcome; ordinary service code creates the new account-owned binding and pairing challenge. Existing bound `0.3.7` clients remain compatible, while takeover requires the new proof.

**Tech Stack:** TypeScript 6, Zod, Drizzle ORM, PostgreSQL 17/RLS, Vitest, esbuild, pnpm

**Spec:** `docs/superpowers/specs/2026-08-20-channel-session-takeover-design.md`

## Global Constraints

- The newest WeChat QR-login session replaces old bindings even when the old Bridge is healthy or belongs to another Attention account.
- The raw iLink account ID and `bot_token` remain local; only distinct domain-separated SHA-256 fingerprints may be reported.
- A replaced session fingerprint must never reclaim ownership.
- Cross-account database work must expose no old account, installation, binding, token, or fingerprint and must not broaden normal RLS policies.
- CLI release version is exactly `0.3.8`.
- `apps/web/public/cli` retains only `manifest.json` and `attention-0.3.8.mjs`; tracked `0.1.0` through `0.3.7` bundles are deleted.
- Local installed Bridge files and `~/.attention` state are never deleted or rewritten by repository cleanup.

---

### Task 1: Runtime Contract and Local Session Identity

**Files:**
- Modify: `packages/contracts/src/channel-runtime.ts`
- Test: `packages/contracts/src/channel-runtime.test.ts`
- Create: `apps/cli/src/channel/runtime-identity.ts`
- Create: `apps/cli/src/channel/runtime-identity.test.ts`

**Interfaces:**
- Produces: `CreateChannelBindingRequest.channel_session_fingerprint?: string`
- Produces: `opaqueRuntimeFingerprint(namespace: string, value: string): string`
- Produces: `channelSessionFingerprint(token: string): string`, using namespace `wechat_ilink_session`
- Consumes later: Runtime Reporter identity receives the returned 64-character lowercase hex digest.

- [ ] **Step 1: Add failing contract tests**

Add a `sessionFingerprint = "c".repeat(64)` fixture and assertions that the create schema accepts it, rejects malformed values, keeps it optional for a legacy request, and still rejects unknown keys:

```ts
expect(CreateChannelBindingRequestSchema.parse({
  ...createBinding,
  channel_session_fingerprint: sessionFingerprint,
})).toMatchObject({ channel_session_fingerprint: sessionFingerprint });
expect(() => CreateChannelBindingRequestSchema.parse({
  ...createBinding,
  channel_session_fingerprint: "not-a-fingerprint",
})).toThrow();
expect(CreateChannelBindingRequestSchema.parse(createBinding)).toEqual(createBinding);
```

- [ ] **Step 2: Run the contract test and verify RED**

Run: `pnpm vitest run packages/contracts/src/channel-runtime.test.ts`

Expected: FAIL because strict parsing rejects `channel_session_fingerprint`.

- [ ] **Step 3: Extend the request schema minimally**

Add the optional field without changing `ChannelBindingViewSchema`:

```ts
channel_session_fingerprint: OpaqueSha256FingerprintSchema.optional(),
```

- [ ] **Step 4: Add failing CLI identity tests**

Test deterministic domain separation and secret non-disclosure:

```ts
expect(channelSessionFingerprint("local-bot-token"))
  .toMatch(/^[0-9a-f]{64}$/u);
expect(channelSessionFingerprint("local-bot-token"))
  .not.toBe(opaqueRuntimeFingerprint("wechat_ilink", "local-bot-token"));
expect(channelSessionFingerprint("local-bot-token"))
  .not.toContain("local-bot-token");
```

- [ ] **Step 5: Run the CLI identity test and verify RED**

Run: `pnpm vitest run apps/cli/src/channel/runtime-identity.test.ts`

Expected: FAIL because `runtime-identity.ts` does not exist.

- [ ] **Step 6: Implement the fingerprint helpers**

Create the focused module:

```ts
import { createHash } from "node:crypto";

export function opaqueRuntimeFingerprint(namespace: string, value: string): string {
  return createHash("sha256")
    .update(`attention:${namespace}:`, "utf8")
    .update(value, "utf8")
    .digest("hex");
}

export function channelSessionFingerprint(token: string): string {
  if (!token) throw new Error("ilink_session_missing");
  return opaqueRuntimeFingerprint("wechat_ilink_session", token);
}
```

- [ ] **Step 7: Run focused tests and verify GREEN**

Run: `pnpm vitest run packages/contracts/src/channel-runtime.test.ts apps/cli/src/channel/runtime-identity.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit the contract boundary**

```bash
git add packages/contracts/src/channel-runtime.ts packages/contracts/src/channel-runtime.test.ts apps/cli/src/channel/runtime-identity.ts apps/cli/src/channel/runtime-identity.test.ts
git commit -m "feat: add channel session identity"
```

### Task 2: Database Tombstones and Cross-Account Replacement Primitive

**Files:**
- Modify: `packages/db/src/schema.ts`
- Test: `packages/db/src/channel-runtime-schema.test.ts`
- Create: `packages/db/drizzle/0035_channel_session_takeover.sql`
- Create: `packages/db/drizzle/meta/0035_snapshot.json`
- Modify: `packages/db/drizzle/meta/_journal.json`
- Test: `apps/web/src/server/channel-runtime-service.integration.test.ts`

**Interfaces:**
- Produces column: `externalChannelBindings.channelSessionFingerprint: string | null`
- Produces SQL function:
  `replace_active_channel_binding_owner(uuid, uuid, local_channel_provider, char(64), char(64)) returns text`
- Outcome values: `none`, `replaced`, `channel_session_proof_required`, `channel_session_superseded`
- Consumes later: `ChannelRuntimeService.createChannelBinding` calls the function inside its principal transaction.

- [ ] **Step 1: Add a failing schema test**

Assert the nullable column, format check, and lookup index exist while the global active-owner index remains unique:

```ts
expect(externalChannelBindings.channelSessionFingerprint.notNull).toBe(false);
expect(bindingConfig.checks.map(({ name }) => name))
  .toContain("external_channel_bindings_session_fingerprint_format");
expect(bindingConfig.indexes.map(({ config }) => config.name))
  .toContain("external_channel_bindings_session_lookup_idx");
```

- [ ] **Step 2: Run the schema test and verify RED**

Run: `pnpm vitest run packages/db/src/channel-runtime-schema.test.ts`

Expected: FAIL because the column, check, and index are absent.

- [ ] **Step 3: Add the Drizzle schema field and index**

Add a nullable `char(64)` field, the hex-or-null check, and a non-unique index over provider, account fingerprint, and session fingerprint. Also add `channel.binding.replaced.v1` to the Runtime event-ledger insert/read policy allowlist.

- [ ] **Step 4: Generate the named migration**

Run: `pnpm --filter @attention/db exec drizzle-kit generate --name channel_session_takeover`

Expected: creates `0035_channel_session_takeover.sql`, `0035_snapshot.json`, and updates `_journal.json`.

- [ ] **Step 5: Add a failing integration test for the SQL primitive**

Create two accounts, OAuth clients, installations, and an active binding for account A. Under account B's principal transaction call the function with a new session fingerprint. Assert it returns `replaced`, account A's binding is `revoked`, its pending challenge is revoked, and no old identifiers are returned. Then call with the retired session fingerprint and assert `channel_session_superseded`; call without a proof against existing history and assert `channel_session_proof_required`.

- [ ] **Step 6: Run the database integration test and verify RED**

Run: `pnpm vitest run apps/web/src/server/channel-runtime-service.integration.test.ts`

Expected when `TEST_DATABASE_URL` is configured: FAIL because the function does not exist. If the suite reports its documented database skip, record the skip and rely on CI after completing unit/schema coverage.

- [ ] **Step 7: Append the least-privilege SQL function to migration 0035**

The function must:

```sql
PERFORM pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(p_provider::text || ':' || p_channel_fingerprint, 0)
);
```

It validates `p_new_account_id = NULLIF(current_setting('app.account_id', true), '')::uuid`, verifies the new installation/account pair, checks historical session reuse, revokes unconsumed challenges, revokes active bindings, and returns one stable text outcome. Define it as `SECURITY DEFINER SET search_path = pg_catalog`, fully qualify all `public` objects, `REVOKE ALL ... FROM PUBLIC`, then `GRANT EXECUTE ... TO attention_web_runtime`.

- [ ] **Step 8: Run schema and integration tests and verify GREEN**

Run: `pnpm vitest run packages/db/src/channel-runtime-schema.test.ts apps/web/src/server/channel-runtime-service.integration.test.ts`

Expected: PASS, or only the integration test's explicit database-unavailable skip.

- [ ] **Step 9: Commit storage and migration**

```bash
git add packages/db/src/schema.ts packages/db/src/channel-runtime-schema.test.ts packages/db/drizzle apps/web/src/server/channel-runtime-service.integration.test.ts
git commit -m "feat: add atomic channel owner replacement"
```

### Task 3: Service-Level Replacement and Privacy-Safe Audit

**Files:**
- Modify: `apps/web/src/server/channel-runtime-service.ts`
- Test: `apps/web/src/server/channel-runtime-service.integration.test.ts`
- Test: `apps/web/src/server/channel-runtime-service.test.ts`
- Test: `apps/web/src/server/channel-runtime-http.test.ts`

**Interfaces:**
- Produces service errors: `channel_session_proof_required` and `channel_session_superseded`, both HTTP 409.
- Consumes SQL outcomes from Task 2.
- Preserves response: `{ challenge: ChannelBindingChallenge }`, HTTP 201.

- [ ] **Step 1: Add failing replacement behavior tests**

Cover each old active status (`reported`, `verified`, `healthy`, `stale`), same-account/different-installation, cross-account, same-installation/same-session recovery, and privacy-safe HTTP errors. The key end-to-end assertion is:

```ts
const challenge = await serviceB.createChannelBinding(principalB, {
  ...createInputB,
  channel_account_fingerprint: sharedChannelFingerprint,
  channel_session_fingerprint: newSessionFingerprint,
});
expect(challenge.binding_id).not.toBe(oldBindingId);
expect(await activeOwners(sharedChannelFingerprint)).toHaveLength(1);
```

- [ ] **Step 2: Run focused service tests and verify RED**

Run: `pnpm vitest run apps/web/src/server/channel-runtime-service.test.ts apps/web/src/server/channel-runtime-http.test.ts apps/web/src/server/channel-runtime-service.integration.test.ts`

Expected: FAIL with the current `channel_owner_conflict` behavior.

- [ ] **Step 3: Implement the minimal service flow**

Inside `createChannelBinding`:

1. lock/read a current-principal matching binding;
2. renew/reset it when installation and session are identical;
3. otherwise call `replace_active_channel_binding_owner`;
4. map proof/superseded outcomes to typed 409 errors;
5. insert the new `reported` row with `channelSessionFingerprint`;
6. revoke prior current-row challenges, create one fresh challenge;
7. append `channel.binding.replaced.v1` only when the outcome is `replaced`.

Do not include the session fingerprint or old-row metadata in response views/events.

- [ ] **Step 4: Run focused service tests and verify GREEN**

Run the command from Step 2.

Expected: PASS, or only the documented PostgreSQL integration skip.

- [ ] **Step 5: Commit service behavior**

```bash
git add apps/web/src/server/channel-runtime-service.ts apps/web/src/server/channel-runtime-service.test.ts apps/web/src/server/channel-runtime-http.test.ts apps/web/src/server/channel-runtime-service.integration.test.ts
git commit -m "fix: replace stale channel owners safely"
```

### Task 4: Reporter Proof, Stable Failure Handling, and Recovery

**Files:**
- Modify: `apps/cli/src/channel/runtime-reporter.ts`
- Test: `apps/cli/src/channel/runtime-reporter.test.ts`
- Modify: `apps/cli/src/channel/channel-command.ts`
- Test: `apps/cli/src/channel/channel-command.test.ts`

**Interfaces:**
- Adds `RuntimeReporterIdentity.channelSessionFingerprint: string`
- Reporter request serializes `channel_session_fingerprint` but never the token.
- Stable local states: `runtime_channel_session_superseded`, `runtime_channel_session_proof_required`, and existing generic delivery errors.

- [ ] **Step 1: Add a failing Reporter payload test**

Pass a known session digest in the test identity and assert the binding POST contains it and contains no raw token fixture:

```ts
expect(bindingRequest).toMatchObject({
  channel_session_fingerprint: sessionFingerprint,
});
expect(JSON.stringify(bindingRequest)).not.toContain("local-bot-token");
```

Add 409 response fixtures for both stable server codes and assert the Reporter becomes degraded with the matching stable local error without rotating installation identity or retrying ownership.

- [ ] **Step 2: Run Reporter tests and verify RED**

Run: `pnpm vitest run apps/cli/src/channel/runtime-reporter.test.ts`

Expected: FAIL because the identity and payload omit session proof and all 409 responses collapse to `runtime_report_rejected`.

- [ ] **Step 3: Implement Reporter payload and stable error parsing**

Include the proof in `CreateChannelBindingRequestSchema.parse`. Preserve non-secret JSON error codes from non-retryable responses and map only the two approved channel-session codes; discard all other bodies as today.

- [ ] **Step 4: Add a failing Channel command wiring test**

Use state token `local-ilink-token` and assert the Reporter factory receives
`channelSessionFingerprint("local-ilink-token")`. Assert status logging explains that a superseded session must scan again and that proof-required clients must update.

- [ ] **Step 5: Run Channel command tests and verify RED**

Run: `pnpm vitest run apps/cli/src/channel/channel-command.test.ts`

Expected: FAIL because the command does not pass session identity or specialized copy.

- [ ] **Step 6: Wire the shared identity helper**

Replace the private `opaqueFingerprint` implementation with the Task 1 helper, pass `channelSessionFingerprint(runtime.state.token)` when constructing Reporter identity, and keep token access local to `channel-command.ts`.

- [ ] **Step 7: Run CLI Channel tests and verify GREEN**

Run: `pnpm vitest run apps/cli/src/channel/runtime-identity.test.ts apps/cli/src/channel/runtime-reporter.test.ts apps/cli/src/channel/channel-command.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit Reporter integration**

```bash
git add apps/cli/src/channel/runtime-identity.ts apps/cli/src/channel/runtime-reporter.ts apps/cli/src/channel/runtime-reporter.test.ts apps/cli/src/channel/channel-command.ts apps/cli/src/channel/channel-command.test.ts
git commit -m "feat: report wechat session ownership"
```

### Task 5: Publish CLI 0.3.8 and Prune Historical Public Bundles

**Files:**
- Modify: `apps/cli/package.json`
- Modify: `apps/cli/src/version.ts`
- Modify: version assertions in `apps/cli/src/**/*.test.ts`
- Modify: `apps/web/public/skills/attention/INSTALL.md`
- Delete: `apps/web/public/cli/attention-0.1.0.mjs` through `attention-0.3.7.mjs`
- Create: `apps/web/public/cli/attention-0.3.8.mjs`
- Modify: `apps/web/public/cli/manifest.json`
- Test: `apps/web/src/server/attention-cli-artifact.test.ts`
- Test: `apps/web/src/server/bridge-update-view.test.ts`

**Interfaces:**
- Publishes manifest version `0.3.8` and path `/cli/attention-0.3.8.mjs`.
- Leaves `minimum_supported_version` unchanged unless an existing release test requires the session-proof floor to be explicit.

- [ ] **Step 1: Add a failing retention assertion**

Extend `attention-cli-artifact.test.ts` to enumerate `apps/web/public/cli` and require exactly:

```ts
expect(publicCliFiles.sort()).toEqual([
  "attention-0.3.8.mjs",
  "manifest.json",
]);
```

- [ ] **Step 2: Run artifact tests and verify RED**

Run: `pnpm vitest run apps/web/src/server/attention-cli-artifact.test.ts apps/web/src/server/bridge-update-view.test.ts`

Expected: FAIL because the current release is `0.3.7` and historical bundles exist.

- [ ] **Step 3: Bump source and documentation versions**

Set package/version constants and current-release documentation to `0.3.8`. Update assertions that intentionally test the current version; retain older sample versions where they exercise upgrade/rollback behavior.

- [ ] **Step 4: Generate the current artifact**

Run: `pnpm cli-artifact:sync`

Expected: writes `attention-0.3.8.mjs` and updates `manifest.json` with its SHA-256.

- [ ] **Step 5: Delete only tracked historical public artifacts**

Delete the eleven explicit repository paths `attention-0.1.0.mjs`, `attention-0.2.0.mjs`, `attention-0.2.1.mjs`, and `attention-0.3.0.mjs` through `attention-0.3.7.mjs`. Do not touch `~/.attention`, CLI build output, or local managed Bridge versions.

- [ ] **Step 6: Verify artifact and release tests GREEN**

Run: `pnpm cli-artifact:check && pnpm vitest run apps/web/src/server/attention-cli-artifact.test.ts apps/web/src/server/bridge-update-view.test.ts apps/cli/src/bridge-update-contract.test.ts apps/cli/src/channel/bridge-updater.test.ts`

Expected: PASS and `find apps/web/public/cli -maxdepth 1 -type f` lists only manifest plus `0.3.8`.

- [ ] **Step 7: Commit the release artifact and cleanup**

```bash
git add apps/cli apps/web/public/skills/attention/INSTALL.md apps/web/public/cli apps/web/src/server/attention-cli-artifact.test.ts apps/web/src/server/bridge-update-view.test.ts
git commit -m "chore: publish attention cli 0.3.8"
```

### Task 6: Full Verification, Review, Merge, and Deployment Handoff

**Files:**
- Modify only if verification reveals an in-scope defect.
- Verify: `deploy/staging/preflight.sh`
- Verify: `deploy/staging/smoke-test.sh`
- Verify: `deploy/staging/check-public-surface.sh`

**Interfaces:**
- Produces a clean commit series on `codex/channel-session-takeover`.
- Produces an updated `origin/main` merge commit and exact staging deployment SHA.

- [ ] **Step 1: Run repository verification**

Run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm cli-artifact:check
git diff --check
```

Expected: all commands pass with no warnings attributable to this change. Record any explicit PostgreSQL integration skip rather than presenting it as a pass.

- [ ] **Step 2: Inspect migration and artifact invariants**

Verify the migration defines the fixed search path, revokes `PUBLIC`, grants only `attention_web_runtime`, validates `app.account_id`, and never returns old identifiers. Verify manifest SHA-256 equals the generated bundle and historical public bundles are absent.

- [ ] **Step 3: Review the branch diff**

Run:

```bash
git status --short
git diff --stat origin/main...HEAD
git diff --check origin/main...HEAD
git log --oneline origin/main..HEAD
```

Expected: only the approved design, plan, runtime takeover, migration, tests, version/docs, generated current bundle, and historical bundle deletions appear.

- [ ] **Step 4: Commit any final plan/check updates**

```bash
git add docs/superpowers/plans/2026-08-20-channel-session-takeover.md
git commit -m "docs: plan channel session takeover"
```

- [ ] **Step 5: Push the feature branch and merge into latest main**

Fetch `origin/main`, merge it into the feature branch if it advanced, rerun focused verification, push the feature branch, then merge with a non-destructive merge commit into local `main` and push `main`. Never force-push or reset user work.

- [ ] **Step 6: Provide exact user-run deployment commands**

Use the merged `origin/main` commit as `attention_release_sha`; reuse the established staging sequence: fetch the SHA, detached clean checkout, write `/var/lib/attention-staging/expected-release`, then run `preflight.sh`, `deploy.sh`, and `smoke-test.sh --public`.

- [ ] **Step 7: Post-deployment verification**

After the user deploys, verify public health, manifest `0.3.8`, artifact checksum, internal ports, migration behavior, local Bridge update, creation of a fresh pairing challenge, successful WeChat code verification, Runtime heartbeat, and `/agent` showing the full path connected.
