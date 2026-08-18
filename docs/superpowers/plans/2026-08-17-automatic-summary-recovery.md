# Automatic Summary Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically let the user's local Agent complete any eligible missing summary discovered through collection status, without asking for a second confirmation.

**Architecture:** Move the existing enrichment decision into one shared server helper and use it for both established collection responses and owner-scoped status responses. Extend the strict MCP output contract so the status result carries the same safe `enrichment_action` and `public_read_url`, then teach the Codex and Claude resident workflows to treat that instruction as authoritative and return only fixed content-free acknowledgements.

**Tech Stack:** TypeScript, Zod, Drizzle/PostgreSQL, MCP, Codex app-server, Claude Code stream-json, Vitest, pnpm/esbuild.

## Global Constraints

- A URL or share text in the designated WeChat channel is already an explicit save request; never ask for confirmation.
- Only an owner-scoped, active, safe, non-terminal Content may expose `public_read_url` for enrichment.
- Ready summaries are reused; hidden, terminal, removed, blocked, merged, or moderation-ineligible Content is never regenerated.
- The Agent may read only the exact absolute URL returned by Attention and may submit title, resolved URL, summary, and tags—never page text, cookies, credentials, or browser state.
- Codex and Claude Code must have the same workflow and fixed user-facing result.

---

### Task 1: Server-authoritative status recovery contract

**Files:**
- Create: `apps/web/src/server/content-enrichment-decision.ts`
- Modify: `apps/web/src/server/collection-service.ts`
- Modify: `apps/web/src/server/collection-status-service.ts`
- Modify: `packages/contracts/src/attention-tool-output.ts`
- Test: `apps/web/src/server/collection-service.test.ts`
- Test: `apps/web/src/server/attention-tool-registry.test.ts`
- Test: `tests/integration/db-auth.test.ts`

**Interfaces:**
- Produces: `enrichmentResponseFields(content, publicReadUrl)` as the single mapping used by collection and status services.
- Produces: `content.enrichment_action` and `content.public_read_url` in `attention_get_collection_status` success output.

- [x] Write RED tests proving pending owned Content returns `generate_summary` plus its exact outbound URL while ready and terminal/ineligible Content return no URL.
- [x] Run the focused contract/service tests and confirm failure because status output omits the recovery fields.
- [x] Extract the shared decision helper and project it from the owner-scoped status query.
- [x] Run focused tests and real PostgreSQL ownership/eligibility coverage.

### Task 2: Automatic Codex and Claude recovery workflow

**Files:**
- Modify: `apps/cli/src/channel/collection-reply-control.ts`
- Modify: `apps/cli/src/channel/prompt.ts`
- Modify: `apps/web/public/skills/attention/SKILL.md`
- Test: `apps/cli/src/channel/collection-reply-control.test.ts`
- Test: `apps/cli/src/channel/brains/codex-resident.test.ts`
- Test: `apps/cli/src/channel/brains/claude-resident.test.ts`
- Test: `apps/cli/src/channel/pipeline.test.ts`
- Test: `apps/cli/src/channel/prompt.test.ts`

**Interfaces:**
- Consumes: status `content.enrichment_action`, `content.public_read_url`, and `content.content_id`.
- Produces: content-free recovery control with fixed acknowledgements for completed, reused, pending, and unavailable states.

- [x] Write RED host-protocol tests for status → public read → submit on Codex and Claude, including an empty model reply and adversarial model prose.
- [x] Write RED prompt tests proving no second confirmation and exact-URL-only reading.
- [x] Implement status-result correlation and fixed recovery acknowledgements without retaining URL/title/summary/tag payloads in Bridge state.
- [x] Run all channel tests and confirm normal chat and initial collection behavior remain unchanged.

### Task 3: Versioned public artifacts and verification

**Files:**
- Modify: `apps/cli/package.json`
- Modify: `packages/contracts/src/attention-capability-manifest.ts`
- Modify: `packages/contracts/src/agent-installation.ts`
- Modify: `apps/web/src/server/attention-tool-registry.ts`
- Generate: public Skill, WorkBuddy, installation, capability, and CLI artifacts.

- [x] Bump the MCP contract, Skill package, and CLI versions because the public output/workflow contract changed.
- [x] Run capability, installation, and CLI artifact sync; inspect generated diffs and hashes.
- [x] Run focused suites, repository typechecks/lint, full tests, and `git diff --check`.
- [x] Review for privacy, ownership, terminal-state, Codex/Claude parity, and generated-artifact consistency before committing.
