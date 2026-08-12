# Local Agent Content Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the Agent that collected a link fill the first missing shared Content summary and tags through Attention MCP, while keeping missing summaries pending when Hosted AI is absent.

**Architecture:** Collection remains the deduplication boundary and returns a server-decided enrichment action. A new account-scoped Content enrichment service performs the only canonical summary/tag write with first-writer-wins concurrency. MCP exposes that service, Worker metadata preserves concurrent state, and Codex/Claude designated channels read public pages only when the collection response requests it.

**Tech Stack:** TypeScript 6, Zod, Next.js 16 server modules, Drizzle ORM, PostgreSQL 17, MCP SDK, Vitest, resident Codex app-server, resident Claude Code stream-json.

## Global Constraints

- Content owns one shared summary and tag set; Collection owns account attribution and private/public visibility.
- The first valid summary wins regardless of Member or Filter role; later writes return `already_enriched` without overwrite.
- Agents submit only a summary of at most 2,000 characters and 1–8 unique tags of at most 64 characters each.
- The caller must own an active Collection for the exact Content and have `collection:write`; foreign Content is reported as not found.
- Do not upload or log page text, raw URL, cookies, authorization headers, browser state, summary text, or tag values.
- Missing Hosted AI configuration leaves summaries `pending`; this plan does not assign any future product role to Hosted AI.
- Codex and Claude may read public pages for this workflow, but Shell, code execution, file writes, private/authenticated browsing, and non-Attention MCP servers remain disabled.
- Pending UI copy is exactly `摘要待补全` and uses a neutral/non-error treatment.
- Bump the MCP tool contract, Skill package, CLI artifact, manifests, hashes, and generated public artifacts together.

---

### Task 1: Canonical enrichment contract and transactional service

**Files:**
- Create: `apps/web/src/server/content-enrichment-service.ts`
- Create: `apps/web/src/server/content-enrichment-service.test.ts`
- Modify: `packages/contracts/src/collector-response.ts`
- Modify: `packages/contracts/src/attention-tool-output.ts`
- Modify: `packages/contracts/src/attention-capability-manifest.ts`
- Modify: `apps/web/src/server/collection-service.ts`
- Modify: `apps/web/src/server/attention-tool-registry.ts`
- Modify: `apps/web/src/server/attention-tool-registry.test.ts`
- Modify: `apps/web/src/server/mcp-tool-adapter.test.ts`
- Modify: `apps/web/src/server/attention-tool-audit.ts`

**Interfaces:**
- Produces `submitContentEnrichment(db, principal, input): Promise<{contentId; status: "enriched" | "already_enriched"; summaryStatus: "ready"}>`.
- Adds `summary_status` and `enrichment_action` to every established collector response.
- Adds MCP tool `attention_submit_content_enrichment` under `collection:write`.

- [ ] **Step 1: Write RED contract tests** asserting established collector responses require `summary_status` (`ready|pending|unavailable|hidden`) and `enrichment_action` (`reuse_summary|generate_summary|none`), and that the new strict tool output accepts only `enriched|already_enriched` with `summary_status=ready`.
- [ ] **Step 2: Run the focused contract tests** with `pnpm exec vitest run packages/contracts/src/collector-response.test.ts apps/web/src/server/attention-tool-registry.test.ts apps/web/src/server/mcp-tool-adapter.test.ts` and confirm failures are caused by the missing fields/tool.
- [ ] **Step 3: Write RED service tests** using a real temporary PostgreSQL database for owned active Collection success, normal-user then Filter reuse, inactive/foreign ownership hidden as not found, hidden/ineligible rejection, idempotent retry, and two concurrent first-writer calls producing one immutable winner.
- [ ] **Step 4: Run the service tests** and confirm they fail because the service does not exist.
- [ ] **Step 5: Implement the service and collection mapping** with one transaction, account context, ownership check, row lock/conditional update, normalized unique tags, and no summary/tag values in audit/log metadata. Treat legacy `failed|unavailable|pending` without stored summary as `generate_summary`; `ready` as reuse; `hidden` as none.
- [ ] **Step 6: Register the MCP tool** with input `{content_id, summary, tags, idempotency_key, client_context}`, `collection:write`, idempotent annotation, stable errors, output validation, audit content ID only, and capability manifest parity.
- [ ] **Step 7: Run focused tests and typechecks** for contracts, Web, MCP, and real-DB service; then commit `feat: add shared content enrichment MCP`.

### Task 2: Worker state correctness and legacy repair

**Files:**
- Modify: `apps/worker/src/handlers.ts`
- Modify: `apps/worker/src/production-handlers.ts`
- Modify: `apps/worker/src/production-handlers.test.ts`
- Modify: `tests/integration/db-auth.test.ts`
- Create: `packages/db/drizzle/0032_local_agent_enrichment_repair.sql`
- Modify: `packages/db/drizzle/meta/_journal.json`
- Modify: `tests/migration-snapshot.test.ts`

**Interfaces:**
- Metadata finalization derives summary state from the locked database row, not the pre-handler snapshot.
- `JobHandlers` exposes whether Hosted summary execution is configured, so metadata schedules no summary job when it is absent.

- [ ] **Step 1: Write RED Worker tests** proving Provider absence does not enqueue/complete a summary job or set `unavailable`, and a ready summary written while metadata is running remains ready after metadata completion.
- [ ] **Step 2: Run focused Worker/integration tests** and confirm the current code produces unavailable and loses the concurrent state.
- [ ] **Step 3: Implement minimal Worker capability/state changes**: expose configured summary availability; schedule only when configured and entitled; preserve locked row `ready|hidden`; keep all other missing summaries pending; make summary finalization first-writer-safe.
- [ ] **Step 4: Write RED migration tests** for changing only active, unmoderated, no-summary legacy `unavailable|failed` rows to `pending`, including the completed-job inconsistency, while preserving ready/hidden/safety/takedown rows.
- [ ] **Step 5: Add migration 0032** with descriptive guards and runtime-role compatibility; do not replay summary jobs.
- [ ] **Step 6: Run Worker, migration, and PostgreSQL integration suites** and commit `fix: keep local enrichment summaries pending`.

### Task 3: Skill, Codex/Claude channel workflow, and published artifacts

**Files:**
- Modify: `apps/web/public/skills/attention/SKILL.md`
- Modify: `apps/web/public/skills/attention/INSTALL.md`
- Modify: `apps/web/src/server/attention-skill-contract.test.ts`
- Modify: `apps/cli/src/channel/prompt.ts`
- Modify: `apps/cli/src/channel/prompt.test.ts`
- Modify: `apps/cli/src/channel/brains/codex.ts`
- Modify: `apps/cli/src/channel/brains/codex-resident.ts`
- Modify: `apps/cli/src/channel/brains/claude-resident.ts`
- Modify: `apps/cli/src/channel/brains/brains.test.ts`
- Modify: `apps/cli/package.json`
- Modify: `packages/contracts/src/agent-installation.ts`
- Regenerate: `apps/web/public/skills/attention/installations/v1/**`
- Regenerate: `apps/web/public/skills/attention/capabilities/v1/**`
- Regenerate: `apps/web/public/cli/manifest.json`
- Create: versioned CLI artifact and WorkBuddy bundle for the new versions.

**Interfaces:**
- Both hosts receive the new tool in their Attention allowlist and execute the same collect→conditional public read→submit workflow.
- Public Skill tells every Agent to skip reading on `reuse_summary`, read only public source on `generate_summary`, and leave pending rather than fabricate on read failure.

- [ ] **Step 1: Write RED Skill/prompt/host tests** for the new tool name, exact conditional workflow, summary-only upload boundary, Codex public-network read sandbox, Claude public WebFetch/WebSearch allowance, and continued denial of Shell/files/other MCP.
- [ ] **Step 2: Run focused tests** and confirm the old Skill and host allowlists fail them.
- [ ] **Step 3: Update Skill and channel prompts** with the two-step protocol, `already_enriched` success semantics, and public-only reading boundary.
- [ ] **Step 4: Update host restrictions** by adding only the new MCP write tool and minimum public-web reading capability; preserve isolated Attention MCP and all unrelated denies.
- [ ] **Step 5: Bump and regenerate versions/artifacts**: MCP contract, Skill, CLI, WorkBuddy ZIP, SHA constants, capability JSON, installation JSON, and CLI manifest/bundle.
- [ ] **Step 6: Run Codex and Claude host tests, Skill contract tests, artifact sync/checks, CLI build/typecheck** and commit `feat: let local agents complete content summaries`.

### Task 4: Web pending state and end-to-end acceptance

**Files:**
- Modify: `apps/web/src/components/content-card.tsx`
- Modify: `apps/web/src/components/signal-elements.tsx`
- Modify: relevant component/CSS tests under `apps/web/src/components/`
- Modify: `docs/local-agent-wechat-device-acceptance.md`
- Modify: `deploy/staging/smoke-test.sh` only if the new public artifacts require an additional route assertion.

**Interfaces:**
- Pending/processing and repaired legacy unavailable-without-summary render the neutral `摘要待补全` state.

- [ ] **Step 1: Write RED UI tests** asserting pending copy and no warning icon/error class; ready remains unchanged and genuine terminal unavailable remains distinct.
- [ ] **Step 2: Implement the minimal component/copy changes** using existing Attention tokens and layout; do not redesign cards.
- [ ] **Step 3: Add acceptance instructions** for a fresh local Agent summary, shared reuse by a second account/Filter, concurrent first-writer behavior, read failure staying pending, and Codex/Claude parity.
- [ ] **Step 4: Run full validation**: `pnpm test`, `pnpm typecheck`, `pnpm lint`, package builds, migration snapshot/real PostgreSQL checks, capability/installation/CLI artifact checks, and `git diff --check`.
- [ ] **Step 5: Run live local E2E** with one designated-channel URL for Codex and Claude: verify collect first, only one Agent reads/submits, second collection reuses, card shows summary, and logs contain no raw URL/page/summary/tags.
- [ ] **Step 6: Commit** `test: verify local agent content enrichment` and request whole-branch review before release.
