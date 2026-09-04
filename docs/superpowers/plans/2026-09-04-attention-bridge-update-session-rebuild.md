# Attention Bridge Auto-Update and Session Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the managed Attention Bridge check for compatible updates at startup and every hour, then rebuild version-stale Agent sessions without losing iLink login, queues, idempotency, or text history.

**Architecture:** Extract update timing into a deterministic schedule module used by the service loop. Stamp each persisted Brain session with the Bridge version and permission-profile digest, and only resume sessions whose identity matches the running artifact; incompatible or legacy sessions replay the bounded text transcript into a fresh thread. Keep the existing signed manifest, candidate probe, launcher restart, rollback, and permission-consent boundaries.

**Tech Stack:** TypeScript 6, Node.js 22+, Vitest, pnpm workspace, esbuild single-file CLI artifact.

**Spec:** `docs/superpowers/specs/2026-09-04-attention-bridge-update-session-rebuild-design.md`

## Global Constraints

- Check once immediately after every Bridge service start and once every 60 minutes while running.
- Perform update checks and version switches only while both durable message queues are empty.
- Automatically install only same-major releases with the identical permission-profile SHA-256.
- Preserve iLink login, queue contents, processed-message IDs, text history, OAuth state, and Reporter identity.
- Never resume a Brain session created by another Bridge version, permission profile, or host.
- Legacy sessions without release identity are stale but their transcript remains replayable.
- OAuth or Hosted MCP failure must not roll back an otherwise healthy Bridge release.
- Do not push, publish, deploy, or alter the running user service as part of implementation.

---

### Task 1: Persist and enforce Brain session release identity

**Files:**
- Modify: `apps/cli/src/channel/state.ts`
- Modify: `apps/cli/src/channel/state.test.ts`
- Modify: `apps/cli/src/channel/pipeline.ts`
- Modify: `apps/cli/src/channel/pipeline.test.ts`

**Interfaces:**
- Consumes: `ATTENTION_CLI_VERSION` from `apps/cli/src/version.ts` and `ATTENTION_BRIDGE_PERMISSION_PROFILE_SHA256` from `apps/cli/src/bridge-update-contract.ts`.
- Produces: optional persisted `BrainSession.bridgeVersion` and `BrainSession.permissionProfileSha256`; compatible-session predicate used before `thread/resume`.

- [ ] **Step 1: Write state migration tests for session identity**

Add tests proving a fully identified session round-trips, while legacy session records remain loadable with both new fields absent:

```ts
it("round-trips a Brain session release identity", async () => {
  const state = defaultChannelState();
  state.brainSession = {
    bridgeVersion: "0.3.14",
    hostId: "codex",
    permissionProfileSha256: "a".repeat(64),
    sessionId: "session-1",
    updatedAt: "2026-09-04T00:00:00.000Z",
  };
  await saveChannelState(state, base);
  expect((await loadChannelState(base)).brainSession).toEqual(state.brainSession);
});
```

Also write an invalid-identity test: malformed version or digest must normalize to an identity-less legacy session, never become trusted compatibility evidence.

- [ ] **Step 2: Run the state tests and verify RED**

Run:

```bash
pnpm exec vitest run apps/cli/src/channel/state.test.ts
```

Expected: TypeScript/test failure because `BrainSession` has no release-identity fields or malformed fields are retained.

- [ ] **Step 3: Implement backward-compatible state normalization**

Extend the interface and normalize only strict identities:

```ts
export interface BrainSession {
  readonly bridgeVersion?: string;
  readonly hostId: "codex" | "claude-code";
  readonly permissionProfileSha256?: string;
  readonly sessionId: string;
  readonly updatedAt: string;
}
```

Accept versions matching `^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)$` and digests matching `^[a-f0-9]{64}$`. Preserve `sessionId`, `hostId`, and `updatedAt` for legacy records, but omit untrusted identity fields.

- [ ] **Step 4: Run the state tests and verify GREEN**

Run:

```bash
pnpm exec vitest run apps/cli/src/channel/state.test.ts
```

Expected: all state tests pass.

- [ ] **Step 5: Write pipeline tests for stale-session replay**

Add four cases to `pipeline.test.ts`:

```ts
it.each([
  [undefined, ATTENTION_BRIDGE_PERMISSION_PROFILE_SHA256],
  ["0.3.0", ATTENTION_BRIDGE_PERMISSION_PROFILE_SHA256],
  [ATTENTION_CLI_VERSION, "b".repeat(64)],
])("rebuilds a release-stale session", async (bridgeVersion, digest) => {
  const state = defaultChannelState();
  state.brainSession = {
    ...(bridgeVersion ? { bridgeVersion } : {}),
    hostId: "codex",
    permissionProfileSha256: digest,
    sessionId: "stale-session",
    updatedAt: "2026-09-04T00:00:00.000Z",
  };
  state.history = [
    { role: "user", content: "旧问题" },
    { role: "assistant", content: "旧回答" },
  ];
  const invocations: BrainInvokeInput[] = [];
  await handleInboundMessage({
    brain: fakeBrain("codex"),
    cwd: "/tmp",
    invokeBrain: async (input) => {
      invocations.push(input);
      return okOutcome("已重建", "fresh-session");
    },
    message: textMessage("收藏 https://example.com"),
    state,
  });
  expect(invocations).toHaveLength(1);
  expect(invocations[0]?.sessionId).toBeNull();
  expect(invocations[0]?.prompt).toContain("对话历史");
  expect(state.brainSession).toMatchObject({
    bridgeVersion: ATTENTION_CLI_VERSION,
    permissionProfileSha256: ATTENTION_BRIDGE_PERMISSION_PROFILE_SHA256,
    sessionId: "fresh-session",
  });
});
```

Add a matching-identity case proving the existing session is resumed and receives the follow-up prompt rather than transcript replay. Update pre-existing resume tests to stamp the current identity when they intentionally exercise resume behavior.

- [ ] **Step 6: Run the pipeline tests and verify RED**

Run:

```bash
pnpm exec vitest run apps/cli/src/channel/pipeline.test.ts
```

Expected: stale sessions are incorrectly resumed and fresh records lack identity.

- [ ] **Step 7: Implement compatibility gating and identity stamping**

In `pipeline.ts`, add a strict predicate and use it before deriving `storedSession`:

```ts
function sessionMatchesCurrentRelease(
  session: BrainSession,
  hostId: BrainAdapter["hostId"],
): boolean {
  return session.hostId === hostId &&
    session.bridgeVersion === ATTENTION_CLI_VERSION &&
    session.permissionProfileSha256 ===
      ATTENTION_BRIDGE_PERMISSION_PROFILE_SHA256;
}
```

If a stored session exists but fails the predicate, set `state.brainSession = null` and continue through the existing first-turn/replay path. Stamp both identity fields in `recordSession`. Do not clear `state.history`.

- [ ] **Step 8: Run state and pipeline tests and verify GREEN**

Run:

```bash
pnpm exec vitest run apps/cli/src/channel/state.test.ts apps/cli/src/channel/pipeline.test.ts
```

Expected: all tests pass.

- [ ] **Step 9: Commit the session migration**

```bash
git add apps/cli/src/channel/state.ts apps/cli/src/channel/state.test.ts apps/cli/src/channel/pipeline.ts apps/cli/src/channel/pipeline.test.ts
git commit -m "fix(cli): rebuild stale bridge sessions"
```

### Task 2: Check managed Bridge updates at startup and hourly

**Files:**
- Create: `apps/cli/src/channel/bridge-update-schedule.ts`
- Create: `apps/cli/src/channel/bridge-update-schedule.test.ts`
- Modify: `apps/cli/src/channel/channel-command.ts`
- Modify: `apps/cli/src/channel/channel-command.test.ts`

**Interfaces:**
- Produces: `BRIDGE_UPDATE_INTERVAL_MS = 60 * 60 * 1_000`, `initialBridgeUpdateCheckAt(): number`, and `nextBridgeUpdateCheckAt(checkedAt: number): number`.
- Consumed by: the managed service loop in `channel-command.ts`.

- [ ] **Step 1: Write failing schedule unit tests**

```ts
describe("Bridge update schedule", () => {
  it("checks immediately after each service start", () => {
    expect(initialBridgeUpdateCheckAt()).toBe(0);
  });

  it("checks again exactly one hour after an attempt", () => {
    expect(nextBridgeUpdateCheckAt(1_000)).toBe(3_601_000);
  });
});
```

- [ ] **Step 2: Run the schedule test and verify RED**

Run:

```bash
pnpm exec vitest run apps/cli/src/channel/bridge-update-schedule.test.ts
```

Expected: module-not-found failure because the schedule module does not exist.

- [ ] **Step 3: Implement the deterministic schedule**

```ts
export const BRIDGE_UPDATE_INTERVAL_MS = 60 * 60 * 1_000;

export function initialBridgeUpdateCheckAt(): number {
  return 0;
}

export function nextBridgeUpdateCheckAt(checkedAt: number): number {
  return checkedAt + BRIDGE_UPDATE_INTERVAL_MS;
}
```

- [ ] **Step 4: Run the schedule test and verify GREEN**

Run:

```bash
pnpm exec vitest run apps/cli/src/channel/bridge-update-schedule.test.ts
```

Expected: both tests pass.

- [ ] **Step 5: Write service-loop regression tests**

Extend `channel-command.test.ts` with a production-path startup case that writes a valid managed-update state under the temporary home with `lastCheckAt` equal to the injected current time. Do not inject `bridgeUpdateChecker`; instead let the real updater consume a `fetchImpl` response for `/cli/manifest.json` whose version equals `ATTENTION_CLI_VERSION`, permission digest equals `ATTENTION_BRIDGE_PERMISSION_PROFILE_SHA256`, Node range is `>=22.16.0`, and artifact fields satisfy the strict manifest schema. Assert that the manifest request occurs before the first `/getupdates` request even though the persisted check is recent.

Add a separate clock-driven case where an injected checker first returns `current`, repeated loops before 60 minutes do not recheck, and the first idle loop at 60 minutes checks again. Keep the existing test proving an unsent durable reply prevents checking.

Use an injected mutable clock:

```ts
let now = Date.parse("2026-09-04T00:00:00.000Z");
const checks: number[] = [];
bridgeUpdateClock: () => new Date(now),
bridgeUpdateChecker: async () => {
  checks.push(now);
  return { status: "current", version: ATTENTION_CLI_VERSION };
},
```

The fake `getupdates` sequence advances `now` through `+59m59s` and `+60m`, then terminates through the existing session-expiry fixture.

- [ ] **Step 6: Run the channel-command tests and verify RED**

Run:

```bash
pnpm exec vitest run apps/cli/src/channel/channel-command.test.ts
```

Expected: the production-path startup test makes no manifest request because the persisted 24-hour gate suppresses it, and the interval case does not recheck at 60 minutes.

- [ ] **Step 7: Wire the service loop to the new schedule**

Remove the startup calculation based on persisted `lastCheckAt` and remove the one-hour device jitter. Initialize `nextBridgeUpdateCheckAt` with `initialBridgeUpdateCheckAt()`. After every check result or thrown check, assign `nextBridgeUpdateCheckAt(checkedAt)`. Preserve the existing service-only and empty-queue guards.

- [ ] **Step 8: Run update scheduling and updater regressions**

Run:

```bash
pnpm exec vitest run apps/cli/src/channel/bridge-update-schedule.test.ts apps/cli/src/channel/channel-command.test.ts apps/cli/src/channel/bridge-updater.test.ts apps/cli/src/channel/managed-bridge.test.ts
```

Expected: all tests pass, including permission-consent and rollback tests.

- [ ] **Step 9: Commit the update cadence**

```bash
git add apps/cli/src/channel/bridge-update-schedule.ts apps/cli/src/channel/bridge-update-schedule.test.ts apps/cli/src/channel/channel-command.ts apps/cli/src/channel/channel-command.test.ts
git commit -m "feat(cli): check bridge updates hourly"
```

### Task 3: Prepare the compatible 0.3.14 Bridge artifact

**Files:**
- Modify: `apps/cli/package.json`
- Modify: `apps/cli/src/version.ts`
- Modify: `apps/cli/src/main.test.ts`
- Delete: `apps/web/public/cli/attention-0.3.13.mjs`
- Create: `apps/web/public/cli/attention-0.3.14.mjs`
- Modify: `apps/web/public/cli/manifest.json`

**Interfaces:**
- Consumes: completed source changes from Tasks 1 and 2.
- Produces: a manifest-compatible `0.3.14` artifact with the unchanged permission-profile SHA-256 `008145538ba70eaef4d66a6e99c588dd0cae2087dba8de85202e21f2eb738230`.

- [ ] **Step 1: Write a failing release-identity expectation**

Add an exact release assertion to `apps/cli/src/main.test.ts` before changing production version sources:

```ts
it("identifies the Bridge rebuild release as 0.3.14", () => {
  expect(ATTENTION_CLI_VERSION).toBe("0.3.14");
});
```

In the existing startup-reminder tests, change the injected hypothetical newer version from `0.3.14` to `0.3.15` so the fixture remains newer after the release bump. Keep the expected permission digest unchanged.

- [ ] **Step 2: Run version and artifact tests and verify RED**

Run:

```bash
pnpm exec vitest run apps/cli/src/main.test.ts
```

Expected: the exact release assertion reports `0.3.13` where `0.3.14` is expected.

- [ ] **Step 3: Bump source/package version and generate the artifact**

Set both source identities to `0.3.14`:

```ts
export const ATTENTION_CLI_VERSION = "0.3.14";
```

```json
{
  "name": "@attention/cli",
  "version": "0.3.14"
}
```

Then run:

```bash
pnpm cli-artifact:sync
```

This command builds the CLI, writes `attention-0.3.14.mjs`, removes the superseded public artifact, and updates the manifest SHA-256.

- [ ] **Step 4: Verify exact artifact consistency**

Run:

```bash
pnpm cli-artifact:check
pnpm exec vitest run apps/cli/src/main.test.ts apps/web/src/server/attention-cli-artifact.test.ts tests/cli-artifact-portability.test.ts
```

Expected: artifact check exits zero and all targeted tests pass.

- [ ] **Step 5: Commit the release artifact**

```bash
git add apps/cli/package.json apps/cli/src/version.ts apps/cli/src/main.test.ts apps/web/public/cli
git commit -m "chore(cli): prepare 0.3.14 bridge rebuild artifact"
```

### Task 4: Full regression and release-boundary verification

**Files:**
- Modify only if verification exposes a requirement-related defect: files already listed in Tasks 1-3.

**Interfaces:**
- Consumes: the complete `0.3.14` source and generated artifact.
- Produces: fresh evidence that the implementation, package, manifest, and public artifact agree; no deployment mutation.

- [ ] **Step 1: Run the focused Bridge recovery suite**

```bash
pnpm exec vitest run apps/cli/src/channel apps/cli/src/configure.test.ts apps/cli/src/bridge-update-contract.test.ts apps/cli/src/cli-updater.test.ts apps/cli/src/release-client.test.ts
```

Expected: all tests pass with no unhandled errors.

- [ ] **Step 2: Run type checking and generated-artifact checks**

```bash
pnpm typecheck
pnpm cli-artifact:check
pnpm agent-installations:check
pnpm capabilities:check
```

Expected: every command exits zero.

- [ ] **Step 3: Run repository tests and lint**

```bash
pnpm test
pnpm lint
```

Expected: all tests pass and lint reports no errors.

- [ ] **Step 4: Run the production build**

```bash
pnpm build
```

Expected: every workspace build exits zero.

- [ ] **Step 5: Audit the final diff and release boundary**

```bash
git status --short --branch
git diff --check origin/main...HEAD
git log --oneline --decorate origin/main..HEAD
```

Confirm that `.codex/` remains untracked, no credentials or local Channel state are committed, the permission digest is unchanged, and no remote push or deployment occurred.

- [ ] **Step 6: Report completion and the remaining release step**

Report the commits, `0.3.14` version, focused/full verification results, and that staging deployment is still required before a running `0.3.12` Bridge can discover and exercise the new automatic path.
