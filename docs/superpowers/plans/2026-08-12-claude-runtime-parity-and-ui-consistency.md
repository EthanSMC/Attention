# Claude Runtime Parity and UI Consistency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Claude Code the same resident Channel lifecycle and Attention-owned authorization experience as Codex, then complete a read-only system UI audit and remediate confirmed design-system violations.

**Architecture:** Introduce a Claude stream-json transport and resident Brain adapter behind the existing `BrainAdapter` interface, preserving the shared durable session/20-turn replay pipeline. Promote Claude Runtime reporting only after accepted tests, then reuse one host-neutral Runtime OAuth completion renderer for both profiles. Freeze UI code for an Impeccable audit, save the full findings, and only then apply report-driven fixes using the committed Attention design system.

**Tech Stack:** TypeScript, Node.js child processes and JSONL, Claude Code 2.1.226 stream-json protocol, Vitest, Next.js, Playwright, ESLint, Impeccable.

## Global Constraints

- Claude uses one long-lived `claude -p --input-format stream-json --output-format stream-json --verbose` process per running Channel.
- Codex and Claude expose exactly the same six Attention Channel MCP tools; only collect/select/update writes are pre-approved by the Channel owner.
- No Shell, file, browser, code-execution, plugin, hook, Skill, unrelated MCP, or project customization is available to the Claude resident process.
- Session IDs, prompts, replies, URLs, tokens, installation IDs, and raw WeChat identity never leave the local device through Runtime Reporter.
- Resume stored host session first; explicit missing-session failure falls back to replaying the latest 20 turns.
- Runtime OAuth remains separate from MCP authorization and optional for local-only or MCP collection use.
- Host-owned MCP callback pages are not intercepted; Attention-owned OAuth surfaces use one host-neutral experience.
- The UI audit modifies no production UI code. Audit-driven remediation begins only after the complete report is saved.
- UI fixes reuse PRODUCT.md/DESIGN.md tokens and components; no second design system is introduced.

---

### Task 1: Claude stream-json transport

**Files:**
- Create: `apps/cli/src/channel/claude-stream-rpc.ts`
- Create: `apps/cli/src/channel/claude-stream-rpc.test.ts`

**Interfaces:**
- Produces `ClaudeStreamEvent = { readonly type: string; readonly [key: string]: unknown }`.
- Produces `ClaudeStreamSnapshot = { exitCode: number | null; phase: "idle" | "running" | "stopped"; pid: number | null; signal: NodeJS.Signals | null; stderr: string }`.
- Produces `ClaudeStreamRpc` with `start()`, `sendUserMessage(prompt)`, `onEvent(listener)`, `snapshot()`, and `close()`.

- [ ] **Step 1: Write transport RED tests**

Create a scripted child-process double that emits fragmented JSONL, multiple complete lines, malformed JSON, oversized lines, stderr, process exit, stdin errors, and close events. Assert messages are encoded as one text-only user JSON object per line and that secrets from stdout/stderr are bounded and never included in thrown user-facing errors.

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run apps/cli/src/channel/claude-stream-rpc.test.ts`

Expected: FAIL because the transport module does not exist.

- [ ] **Step 3: Implement the transport**

Use `spawn("claude", args, { shell: false, stdio: ["pipe", "pipe", "pipe"] })`. Bound each protocol line and captured stderr to 262,144 bytes, parse complete JSONL objects only, notify listeners in order, reject writes while not running, and terminate with SIGTERM followed by a two-second SIGKILL fallback.

- [ ] **Step 4: Verify GREEN**

Run the Step 2 command and expect all transport tests to pass.

### Task 2: Resident Claude Brain lifecycle

**Files:**
- Create: `apps/cli/src/channel/brains/claude-resident.ts`
- Create: `apps/cli/src/channel/brains/claude-resident.test.ts`
- Modify: `apps/cli/src/channel/brains/claude-code.ts`
- Modify: `apps/cli/src/channel/brains.test.ts`
- Modify: `apps/cli/src/channel/limits.ts`

**Interfaces:**
- Consumes `ClaudeStreamRpc` from Task 1.
- Produces the existing `BrainAdapter` with `hostId: "claude-code"`.
- Keeps `BrainOutcome.sessionId` equal to Claude's current `session_id`.

- [ ] **Step 1: Write resident lifecycle RED tests**

Cover: two turns in one PID; one system init/session; result success; result error/cancel/timeout; explicit resume on initial start; missing-session `resumeFailed`; unexpected exit with capped restart; restart with persisted session; MCP/tool isolation argv; invoke serialization; shutdown rejecting active and queued turns; explicit start opening a new lifecycle generation.

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run apps/cli/src/channel/brains/claude-resident.test.ts apps/cli/src/channel/brains.test.ts`

Expected: FAIL because the resident adapter does not exist and current Claude invokes a new CLI process per turn.

- [ ] **Step 3: Implement resident event correlation**

Build one active-turn state machine. Accumulate text from assistant message content, resolve only on a matching terminal `result` event with a non-error subtype, update the session from system/result events, and reject incomplete/failed results. Queue invokes through one promise tail and use lifecycle-generation guards matching resident Codex shutdown semantics.

- [ ] **Step 4: Replace the one-shot Claude adapter**

Make `createClaudeCodeBrain` construct `ClaudeStreamRpc` with host-neutral restricted args:

```text
-p --input-format stream-json --output-format stream-json --verbose
--safe-mode --strict-mcp-config --mcp-config <attention-only>
--tools "" --allowedTools <six Attention tools>
```

Pass `--resume <session-id>` only when starting a new process against a stored session. Do not add `--dangerously-skip-permissions` or expose all 14 MCP tools.

- [ ] **Step 5: Verify GREEN and Codex regression**

Run: `pnpm exec vitest run apps/cli/src/channel/claude-stream-rpc.test.ts apps/cli/src/channel/brains/claude-resident.test.ts apps/cli/src/channel/brains.test.ts apps/cli/src/channel/brains/codex-resident.test.ts`

Expected: all resident Claude tests and existing resident Codex tests pass.

### Task 3: Shared recovery, reporting, and capability truth

**Files:**
- Modify: `apps/cli/src/channel/pipeline.ts`
- Modify: `apps/cli/src/channel/pipeline.test.ts`
- Modify: `apps/cli/src/channel/channel-command.ts`
- Modify: `apps/cli/src/channel/channel-command.test.ts`
- Modify: `packages/contracts/src/agent-integration.ts`
- Modify: `packages/contracts/src/agent-integration.test.ts`
- Modify: `packages/contracts/src/agent-installation.test.ts`
- Regenerate: `apps/web/public/skills/attention/installations/v1/agents/claude-code.json`
- Regenerate: `apps/web/public/skills/attention/installations/v1/index.json`

**Interfaces:**
- Consumes the unchanged `BrainAdapter` contract.
- Produces identical recovery semantics and Runtime OAuth availability for accepted Codex and Claude profiles.

- [ ] **Step 1: Write parity RED tests**

Parameterize recovery and Channel integration tests over `codex` and `claude-code`. Assert both persist host-specific session IDs, resume first, replay exactly the bounded history on explicit missing session, preserve FIFO on failure, report generic “Agent Runtime” status copy, and use identical Reporter privacy fields.

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run apps/cli/src/channel/pipeline.test.ts apps/cli/src/channel/channel-command.test.ts packages/contracts/src/agent-integration.test.ts packages/contracts/src/agent-installation.test.ts`

Expected: FAIL on Claude runtime availability, Codex-hardcoded status copy, or missing parity assertions.

- [ ] **Step 3: Implement shared truth**

Remove user-facing Codex-only lifecycle labels where the selected host is available. Promote only Claude's `runtime_reporting.availability` to `available`; keep `can_confirm_runtime` and pairing claims false pending live service evidence. Do not alter native-host profiles.

- [ ] **Step 4: Sync and verify artifacts**

Run: `pnpm agent-installations:sync && pnpm agent-installations:check`

Expected: the Claude manifest exposes shipped Runtime OAuth/reporting without changing its MCP or Skill contract.

### Task 4: Real Claude process acceptance

**Files:**
- Create: `docs/acceptance/2026-08-12-claude-resident-runtime.md`

**Interfaces:**
- Consumes the built CLI adapter and locally installed Claude Code 2.1.226.
- Produces redacted evidence only; no prompt, reply, session ID, or token enters the report.

- [ ] **Step 1: Build and run the restricted resident process**

Run the exact production argv against a controlled Attention MCP test endpoint. Send two benign text turns over one stdin stream and record only PID equality, event types, success booleans, and duration.

- [ ] **Step 2: Verify restart and resume**

Terminate the process between turns, start a new process with the returned session ID, and verify a benign continuity challenge. Then use an invalid session ID and verify the adapter reports `resumeFailed` so the shared 20-turn replay path runs.

- [ ] **Step 3: Verify the security boundary**

Assert initialization exposes only the six Attention MCP tools and no built-in Shell/file/browser tools. Redact session IDs and all message content from the acceptance report.

### Task 5: Unified Attention-owned OAuth experience

**Files:**
- Create: `apps/cli/src/runtime-oauth-completion.ts`
- Create: `apps/cli/src/runtime-oauth-completion.test.ts`
- Modify: `apps/cli/src/runtime-oauth.ts`
- Modify: `apps/cli/src/runtime-oauth.test.ts`
- Modify: `apps/cli/src/configure.test.ts`
- Modify: `apps/web/public/skills/attention/INSTALL.md`

**Interfaces:**
- Produces `runtimeOAuthCompletionResponse(url, routeValid)` returning HTML body, status, and security headers.
- Leaves DCR, PKCE, state validation, token exchange, and credential persistence unchanged.

- [ ] **Step 1: Write OAuth completion RED tests**

Test received, denied, invalid, malformed, and wrong-route states. Assert host-neutral copy, `text/html`, no callback values/secrets, no external assets, no false “connected” claim, 44px close action, and CSP/no-store/no-referrer/nosniff/frame-denial headers.

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run apps/cli/src/runtime-oauth-completion.test.ts apps/cli/src/runtime-oauth.test.ts apps/cli/src/configure.test.ts`

Expected: FAIL because the callback still returns one plain-text sentence and Claude does not yet execute the accepted Runtime OAuth sequence.

- [ ] **Step 3: Implement and integrate the completion document**

Render one self-contained Quiet Signal page with semantic success-received, denied, invalid, and request-error states. Delegate every loopback HTTP response to it. Document MCP OAuth as host-owned and Runtime OAuth as optional shared device-status sync for Codex and Claude.

- [ ] **Step 4: Verify OAuth GREEN**

Run the Step 2 command and existing OAuth security tests. Expect no protocol regression and identical Attention-owned flow for both host profiles.

### Task 6: Pre-audit engineering gates

**Files:**
- Review all files changed by Tasks 1–5.

**Interfaces:**
- Produces a frozen implementation baseline for the read-only UI audit.

- [ ] **Step 1: Run full changed-scope tests and static checks**

Run CLI, contracts, and Web typechecks; full CLI tests; focused Web OAuth/connection tests; ESLint on changed files; CLI build; artifact checks; and `git diff --check`.

- [ ] **Step 2: Commit the capability/OAuth baseline**

Commit resident Claude and OAuth consistency before beginning the audit. The audit must inspect this exact commit and production UI remains unchanged until its report is complete.

### Task 7: Read-only Impeccable UI/UX audit

**Files:**
- Create: `docs/audits/2026-08-12-ui-ux-integrity-audit.md`
- Create screenshots under: `output/playwright/ui-audit-2026-08-12/`

**Interfaces:**
- Consumes the frozen Task 6 commit.
- Produces a complete issue inventory and 20-point health score; no production UI edits.

- [ ] **Step 1: Run source diagnostics**

Use the bundled Impeccable detector on `apps/web/src`. Inspect semantic HTML, labels, ARIA/state, focus, token usage, hard-coded colors, fixed sizing, expensive effects, responsive CSS, and every absolute/product ban. Verify every reported finding manually before inclusion.

- [ ] **Step 2: Run route/state browser matrix**

At 1440px, tablet, and 390px, exercise anonymous/authenticated discovery; locked feed; login module; account/profile/collections; settings identity/security/membership/digest/connections; collect modal; OAuth unique/conflict/replace/cancel/completion; docs; membership/checkout. Test keyboard traversal, Escape/focus return, 200% text zoom, reduced motion, empty/loading/error/success states, and horizontal overflow.

- [ ] **Step 3: Save the complete report before any UI edit**

Score Accessibility, Performance, Responsive Design, Theming, and Anti-Patterns from 0–4. List every verified P0–P3 issue with route, component, file/line, impact, standard/design rule, recommendation, and suggested Impeccable command. Record positive findings and systemic patterns.

- [ ] **Step 4: Commit the read-only audit report**

The report commit contains no production UI changes. This creates an auditable boundary between observation and remediation.

### Task 8: Audit-driven UI remediation

**Files:**
- Modify only files named by verified findings in Task 7.
- Update: `docs/audits/2026-08-12-ui-ux-integrity-audit.md`

**Interfaces:**
- Consumes the saved issue inventory.
- Produces design-system-compliant UI and before/after audit status.

- [ ] **Step 1: Convert findings into testable batches**

Group by shared root cause: accessibility/semantics, token/theme drift, responsive overflow/touch targets, component-state inconsistencies, and anti-pattern/design-system violations. Write a failing component or Playwright assertion before each production change.

- [ ] **Step 2: Fix all P0/P1 and committed-design violations**

Reuse existing components/tokens. Preserve 44px targets, visible focus, 4.5:1 body contrast, 65–75ch prose, 16px cards, 12px controls, flat surfaces, one semantic accent, reduced motion, and no banned decorative patterns.

- [ ] **Step 3: Fix local low-risk P2/P3 issues**

Repair remaining findings when the change is bounded and testable. Mark intentionally deferred issues with an owner/reason in the audit instead of silently dropping them.

- [ ] **Step 4: Rerun the browser matrix and update scores**

Record resolved/deferred status for every issue and publish the post-remediation 20-point score.

### Task 9: Final verification and release preparation

**Files:**
- Review every branch change.

**Interfaces:**
- Produces one releasable branch with separate capability, audit, and remediation commits.

- [ ] **Step 1: Run full repository gates**

Run all workspace typechecks, tests, builds, lint, installation/CLI artifact sync checks, migration checks when relevant, and `git diff --check`. Capture exact baseline-only failures if any.

- [ ] **Step 2: Run final real-host acceptance**

Verify Codex regression, resident Claude two-turn/restart/resume behavior, both host setup/OAuth sequences, callback pages, and the audited Web route matrix.

- [ ] **Step 3: Self-review and prepare release commit(s)**

Confirm no secret or conversation content in artifacts/logs/reports, no capability overclaim, no unreviewed generated drift, and no audit finding lost between report and remediation.
