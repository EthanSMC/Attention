# Attention CLI Self-Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a verified `attention update` command and a cached startup reminder that lets an Agent discover and explicitly install a newer standalone Attention CLI.

**Architecture:** Extract exact-origin manifest and artifact transport from the Bridge updater into a shared release client. Add a CLI-specific updater that owns origin/cache state and atomically switches only the existing Attention-managed versioned symlink. Integrate a bounded startup check and explicit update command into the CLI dispatcher without changing Bridge version ownership or machine-readable stdout.

**Tech Stack:** TypeScript 6, Node.js 22.16+ filesystem/fetch APIs, Vitest 4, esbuild, pnpm workspace scripts.

**Spec:** `docs/superpowers/specs/2026-09-03-attention-cli-self-update-design.md`

## Global Constraints

- `attention update` performs the update immediately; there is no `--apply` flag.
- Startup checks run at most once per origin in 24 hours with a 1.5 second request deadline.
- Startup-check failures never change the primary command output or exit code.
- Update reminders are written only to `stderr`; JSON and hidden probe stdout stay exact.
- Origin precedence is `--origin`, `ATTENTION_ORIGIN`, then the last successfully validated HTTPS origin.
- Only `~/.local/bin/attention -> ~/.local/share/attention/attention-<semver>.mjs` is self-updated.
- npm, Homebrew, direct-script, and unknown layouts are never overwritten.
- Downloads reject redirects, cross-origin responses, excess sizes, invalid manifests, unsupported Node versions, digest mismatches, and candidate identity mismatches.
- CLI and Bridge versions remain independent.
- The implementation release is `0.3.13`; this task does not push, publish, or deploy it.

---

### Task 1: Shared verified release transport

**Files:**
- Create: `apps/cli/src/release-client.ts`
- Create: `apps/cli/src/release-client.test.ts`
- Modify: `apps/cli/src/channel/bridge-updater.ts`
- Test: `apps/cli/src/channel/bridge-updater.test.ts`

**Interfaces:**
- Consumes: `BridgeUpdateManifest`, `parseBridgeUpdateManifest`, and `resolveBridgeUpdateArtifactUrl` from `apps/cli/src/bridge-update-contract.ts`.
- Produces: `fetchAttentionReleaseManifest(options): Promise<BridgeUpdateManifest>`, `fetchAttentionReleaseArtifact(options): Promise<Buffer>`, `nodeRuntimeSatisfies(version, range): boolean`, and `AttentionReleaseError` with a stable `code`.

- [ ] **Step 1: Write failing release-client tests**

```ts
it("loads only an exact-origin JSON manifest within the configured deadline", async () => {
  const manifest = await fetchAttentionReleaseManifest({
    fetchImpl: fixtureFetch(validManifest),
    origin: "https://attention.example",
    timeoutMs: 1_500,
  });
  expect(manifest.version).toBe("0.3.13");
});

it.each(["redirect", "content_type", "too_large", "invalid_json", "invalid_manifest"])(
  "rejects an unsafe manifest: %s",
  async (fixture) => {
    await expect(fetchAttentionReleaseManifest(unsafeFixture(fixture)))
      .rejects.toMatchObject({ code: expect.any(String) });
  },
);

it("rejects an artifact whose response origin or digest differs", async () => {
  await expect(fetchAttentionReleaseArtifact(mismatchedArtifactFixture()))
    .rejects.toMatchObject({ code: "artifact_digest_mismatch" });
});
```

- [ ] **Step 2: Run the new test and verify RED**

Run: `pnpm exec vitest run apps/cli/src/release-client.test.ts`

Expected: FAIL because `release-client.ts` and its exports do not exist.

- [ ] **Step 3: Implement the shared transport**

```ts
export class AttentionReleaseError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export async function fetchAttentionReleaseManifest(options: {
  readonly fetchImpl?: typeof fetch;
  readonly origin: string;
  readonly timeoutMs: number;
}): Promise<BridgeUpdateManifest>;

export async function fetchAttentionReleaseArtifact(options: {
  readonly fetchImpl?: typeof fetch;
  readonly manifest: BridgeUpdateManifest;
  readonly origin: string;
  readonly timeoutMs: number;
}): Promise<Buffer>;
```

Keep manifest and artifact byte limits at 16 KiB and 16 MiB. Use
`redirect: "error"`, compare the final response origin/path with the expected
URL, reject URL credentials/query/hash, validate JSON content type, parse with
the strict existing manifest parser, and compare SHA-256 before returning
artifact bytes.

- [ ] **Step 4: Refactor the Bridge updater to use the shared transport**

Replace its private fetch/size/content-type/digest helpers with the shared
functions. Map `AttentionReleaseError.code` directly into the existing
`BridgeUpdateCheckResult` without changing Bridge decisions, state, or tests.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `pnpm exec vitest run apps/cli/src/release-client.test.ts apps/cli/src/channel/bridge-updater.test.ts apps/cli/src/bridge-update-contract.test.ts`

Expected: all focused tests PASS.

- [ ] **Step 6: Commit the shared transport**

```bash
git add apps/cli/src/release-client.ts apps/cli/src/release-client.test.ts apps/cli/src/channel/bridge-updater.ts apps/cli/src/channel/bridge-updater.test.ts
git commit -m "refactor(cli): share verified release transport"
```

---

### Task 2: CLI update state, reminders, and managed symlink switching

**Files:**
- Create: `apps/cli/src/cli-updater.ts`
- Create: `apps/cli/src/cli-updater.test.ts`

**Interfaces:**
- Consumes: shared release transport from Task 1, `normalizeAttentionOrigin`, `runCommand`, and `ATTENTION_CLI_VERSION`.
- Produces: `checkCliUpdateAtStartup(options): Promise<CliUpdateNotice | null>` and `updateAttentionCli(options): Promise<CliUpdateResult>`.

```ts
export type CliUpdateNotice = {
  readonly currentVersion: string;
  readonly latestVersion: string;
};

export type CliUpdateResult =
  | { readonly status: "current"; readonly version: string }
  | { readonly status: "updated"; readonly fromVersion: string; readonly toVersion: string; readonly installationKind: "managed_symlink" }
  | { readonly status: "error"; readonly errorCode: string; readonly installationKind: "managed_symlink" | "unsupported" };
```

- [ ] **Step 1: Write failing cache and reminder tests**

```ts
it("uses explicit, environment, then validated saved origin", async () => {
  const requested: string[] = [];
  const fetchImpl = async (input: string | URL | Request) => {
    requested.push(String(input));
    return manifestResponse(String(input), "0.3.13");
  };
  await checkCliUpdateAtStartup({ ...fixture(), explicitOrigin: "https://explicit.example", fetchImpl });
  await checkCliUpdateAtStartup({ ...fixture(), environment: { ATTENTION_ORIGIN: "https://env.example" }, fetchImpl });
  await checkCliUpdateAtStartup({ ...fixtureWithSavedOrigin("https://saved.example"), fetchImpl });
  expect(requested).toEqual([
    "https://explicit.example/cli/manifest.json",
    "https://env.example/cli/manifest.json",
    "https://saved.example/cli/manifest.json",
  ]);
});

it("checks once per origin every 24 hours and keeps a cached reminder", async () => {
  const first = await checkCliUpdateAtStartup(dueFixture());
  const second = await checkCliUpdateAtStartup(notDueFixture());
  expect(first).toEqual({ currentVersion: "0.3.12", latestVersion: "0.3.13" });
  expect(second).toEqual(first);
  expect(requestCount).toBe(1);
});

it("returns null when a 1500ms startup request fails", async () => {
  await expect(checkCliUpdateAtStartup(timeoutFixture())).resolves.toBeNull();
});
```

- [ ] **Step 2: Run cache tests and verify RED**

Run: `pnpm exec vitest run apps/cli/src/cli-updater.test.ts`

Expected: FAIL because the CLI updater does not exist.

- [ ] **Step 3: Implement atomic cache state**

Use `~/.attention/cli-update/state.json`, directory mode `0700`, file mode
`0600`, and write-to-unique-temp plus rename. Parse exact keys and types; treat
malformed state as absent. Record `trustedOrigin` separately from the most
recent per-origin attempt so a failed new origin is rate-limited without
becoming the implicit default.

- [ ] **Step 4: Implement startup checking**

Use a 24-hour constant and pass `1_500` to the shared manifest fetcher. Never
throw from `checkCliUpdateAtStartup`; persist only bounded error codes. Return
a notice only when strict semantic comparison shows `latestVersion` is newer
than `currentVersion`. Preserve a validated notice during an offline check.

- [ ] **Step 5: Run startup tests and verify GREEN**

Run: `pnpm exec vitest run apps/cli/src/cli-updater.test.ts`

Expected: cache/origin/reminder tests PASS.

- [ ] **Step 6: Write failing real-filesystem update tests**

```ts
it("writes a probed versioned artifact and atomically switches the managed symlink", async () => {
  const result = await updateAttentionCli(managedInstallFixture());
  expect(result).toMatchObject({ status: "updated", toVersion: "0.3.13" });
  expect(await readlink(commandPath)).toBe("../share/attention/attention-0.3.13.mjs");
  expect(await readFile(previousArtifact, "utf8")).toContain("0.3.12");
});

it.each(["digest", "probe", "collision", "concurrent_link_change"])(
  "leaves the old command selected after %s failure",
  async (failure) => {
    const fixture = managedFailureFixture(failure);
    expect((await updateAttentionCli(fixture)).status).toBe("error");
    expect(await readlink(fixture.commandPath)).toBe(fixture.originalTarget);
  },
);

it("does not overwrite an unmanaged command", async () => {
  expect(await updateAttentionCli(unmanagedFixture())).toMatchObject({
    errorCode: "unsupported_installation",
    installationKind: "unsupported",
  });
});
```

- [ ] **Step 7: Run update tests and verify RED**

Run: `pnpm exec vitest run apps/cli/src/cli-updater.test.ts`

Expected: new symlink/update cases FAIL because installation switching is not implemented.

- [ ] **Step 8: Implement explicit update and atomic symlink switching**

Validate the managed layout under the injected home directory. Fetch the
artifact with the normal 15-second explicit-update deadline, write the
candidate atomically as mode `0700`, run:

```ts
await runner(
  { args: [candidatePath, "--bridge-update-probe"], executable: process.execPath },
  { timeoutMs: 10_000 },
);
```

Require both version and permission-profile digest to match the manifest.
Re-read the command symlink immediately before replacing it. Create a unique
temporary symlink in `~/.local/bin`, then rename it over `attention`. Do not
delete the previous artifact.

- [ ] **Step 9: Run updater tests and verify GREEN**

Run: `pnpm exec vitest run apps/cli/src/cli-updater.test.ts`

Expected: all CLI updater tests PASS.

- [ ] **Step 10: Commit the CLI updater**

```bash
git add apps/cli/src/cli-updater.ts apps/cli/src/cli-updater.test.ts
git commit -m "feat(cli): add verified self-update core"
```

---

### Task 3: Command dispatcher and non-invasive startup notice

**Files:**
- Modify: `apps/cli/src/main.ts`
- Modify: `apps/cli/src/main.test.ts`
- Modify: `apps/cli/src/index.ts`

**Interfaces:**
- Consumes: `checkCliUpdateAtStartup` and `updateAttentionCli` from Task 2.
- Produces: `attention update [--origin <https-origin>] [--json]` and a startup `stderr` notice for all ordinary invocations.

- [ ] **Step 1: Write failing dispatcher tests**

```ts
it("prints a cached update reminder only on stderr", async () => {
  const capture = captureOutput();
  await runAttentionCli(["--version"], {
    checkCliUpdate: async () => ({ currentVersion: "0.3.12", latestVersion: "0.3.13" }),
    output: capture.output,
  });
  expect(capture.logs).toEqual(["0.3.12"]);
  expect(capture.errors).toEqual([
    "[update] Attention CLI 0.3.13 可用（当前 0.3.12）。运行 `attention update` 升级。",
  ]);
});

it("keeps bridge probe output exact and skips startup checking", async () => {
  let checked = false;
  await runAttentionCli(["--bridge-update-probe"], {
    checkCliUpdate: async () => { checked = true; return null; },
    output: capture.output,
  });
  expect(checked).toBe(false);
  expect(capture.errors).toEqual([]);
});

it("runs attention update directly and preserves JSON stdout", async () => {
  await runAttentionCli(["update", "--json"], {
    runCliUpdate: async () => ({ status: "current", version: "0.3.13" }),
    output: capture.output,
  });
  expect(JSON.parse(capture.logs[0]!)).toEqual({ status: "current", version: "0.3.13" });
});
```

- [ ] **Step 2: Run main tests and verify RED**

Run: `pnpm exec vitest run apps/cli/src/main.test.ts`

Expected: FAIL because update dependencies, reminder, and command routing are absent.

- [ ] **Step 3: Integrate the startup check**

Extend `AttentionCliDependencies` with injectable updater functions, home
directory, entry script, clock, and fetch dependencies. Parse `--origin`
without requiring it for unrelated commands. Skip startup checking only for
`--bridge-update-probe` and `update`; catch every startup-check failure before
dispatch. Emit a notice through `output.error` before normal command output.

- [ ] **Step 4: Integrate `attention update` and help text**

Accept only `--origin` and `--json`. Reject configure/channel-only flags and
positionals. Require a resolved explicit/environment/saved origin inside the
updater. Format human `current`, `updated`, and error outcomes; format the
result object directly for JSON. Return exit code 1 only for explicit update
errors.

- [ ] **Step 5: Wire production entry context**

Pass the actual `process.argv[1]`, `process.env`, home directory, and output
streams from `index.ts`/default dependencies while retaining test injection.

- [ ] **Step 6: Run dispatcher and updater tests and verify GREEN**

Run: `pnpm exec vitest run apps/cli/src/main.test.ts apps/cli/src/cli-updater.test.ts apps/cli/src/release-client.test.ts apps/cli/src/channel/bridge-updater.test.ts`

Expected: all selected tests PASS and hidden probe stdout is unchanged.

- [ ] **Step 7: Commit command integration**

```bash
git add apps/cli/src/main.ts apps/cli/src/main.test.ts apps/cli/src/index.ts
git commit -m "feat(cli): expose update command and startup reminder"
```

---

### Task 4: Release artifact compatibility and final verification

**Files:**
- Modify: `apps/cli/package.json`
- Modify: `apps/cli/src/version.ts`
- Modify: `apps/web/public/cli/manifest.json`
- Delete: `apps/web/public/cli/attention-0.3.12.mjs`
- Create: `apps/web/public/cli/attention-0.3.13.mjs`

**Interfaces:**
- Consumes: the completed CLI entry bundle from Tasks 1–3.
- Produces: one synchronized `0.3.13` package version, manifest, and public artifact.

- [ ] **Step 1: Bump source and package versions together**

Set both `apps/cli/package.json` and `ATTENTION_CLI_VERSION` to `0.3.13`.

- [ ] **Step 2: Regenerate the public CLI artifact**

Run: `pnpm cli-artifact:sync`

Expected: the script creates `attention-0.3.13.mjs`, removes the obsolete
artifact according to repository policy, and writes the exact new SHA-256 to
manifest schema 2.

- [ ] **Step 3: Run release consistency checks**

Run: `pnpm cli-artifact:check && pnpm agent-installations:check && pnpm capabilities:check`

Expected: all three commands exit 0 without generated-file drift.

- [ ] **Step 4: Run focused CLI verification**

Run: `pnpm exec vitest run apps/cli/src/main.test.ts apps/cli/src/cli-updater.test.ts apps/cli/src/release-client.test.ts apps/cli/src/channel/bridge-updater.test.ts apps/cli/src/bridge-update-contract.test.ts`

Expected: all focused tests PASS.

- [ ] **Step 5: Run workspace verification**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm build`

Expected: every command exits 0 with no test failures, type errors, lint
errors, or production build errors.

- [ ] **Step 6: Exercise the generated artifact in a temporary managed install**

Create an isolated temporary home/bin/share layout, point its `attention`
symlink at a copied `0.3.12` fixture, serve the generated manifest/artifact
from a loopback HTTP fixture accepted by the origin policy, and run the built
artifact's update command against it. Verify the symlink changes only after
candidate probing and that `--version` reports `0.3.13`. Do not touch the
real `~/.local/bin/attention` during this test.

- [ ] **Step 7: Review the final diff and commit release artifacts**

```bash
git diff --check
git status --short
git diff --stat main...HEAD
git add apps/cli/package.json apps/cli/src/version.ts apps/web/public/cli/manifest.json apps/web/public/cli/attention-0.3.13.mjs
git add -u apps/web/public/cli
git commit -m "chore(cli): prepare 0.3.13 self-update artifact"
```

- [ ] **Step 8: Report without publishing**

Report the branch, commits, tests, artifact version/hash, install-layout
limitations, and the single manual bootstrap requirement for CLIs older than
`0.3.13`. Do not merge, push, publish npm, or deploy without a new explicit
request.
