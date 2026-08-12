# Claude Runtime Parity and UI Consistency Design

**Status:** Approved for implementation by the user on 2026-08-12  
**Scope:** Local Channel runtime parity, Attention-owned OAuth UX, complete read-only UI audit, and design-system remediation

## Product outcome

Codex and Claude Code are two interchangeable local Agent hosts for Attention.
Choosing one must not change the user's core Channel guarantees:

- one durable conversation;
- one long-lived local Agent process;
- lower repeated-turn startup overhead;
- host session/thread recovery after Bridge or Agent restart;
- fallback reconstruction from the most recent 20 turns;
- strict FIFO processing, bounded retry, and honest local/runtime status;
- the same Attention MCP capability boundary;
- the same Attention-owned authorization, device-sync, and completion semantics.

Protocol implementations may differ internally. Codex uses `app-server --stdio`
JSON-RPC. Claude Code uses its documented `--input-format stream-json` and
`--output-format stream-json` JSONL protocol. Both implement the same
`BrainAdapter` contract and expose the same user-visible lifecycle.

## Claude resident runtime

### Process model

Attention starts one restricted Claude Code process per running Channel:

```text
claude -p
  --input-format stream-json
  --output-format stream-json
  --verbose
  --safe-mode
  --strict-mcp-config
  --mcp-config <Attention-only JSON>
  --tools ""
  --allowedTools <Attention Channel tool allowlist>
```

The process remains alive across turns. Each user turn is one JSONL user message
written to stdin. Attention reads system/assistant/result events from stdout,
correlates exactly one terminal result to the active turn, and never exposes raw
protocol output to the user.

### Capability and safety parity

Claude Code receives the same six Channel tools as resident Codex:

- `attention_get_my_account`
- `attention_list_collections`
- `attention_collect_content`
- `attention_select_collection_candidate`
- `attention_get_collection_status`
- `attention_update_collection`

The three user-approved writes are the collect/select/update operations. Built-in
Shell, file, browser, code execution, plugins, hooks, Skills, unrelated MCPs, and
project customization are unavailable. The process runs in the existing trusted
Channel working directory, but no filesystem tool is exposed.

### Session and failure model

- The Claude `session_id` returned by the stream is persisted in local Channel
  state and is never uploaded by Runtime Reporter.
- On clean Bridge restart, Attention starts Claude with `--resume <session_id>`.
- If resume is explicitly rejected, the stale ID is cleared and the most recent
  20 turns are replayed into a new resident session.
- Unexpected process exit rejects the active turn, preserves durable inbound
  work, and enters the shared capped restart schedule.
- Shutdown rejects active and queued invocations and must not silently create a
  new process until an explicit `start()` opens a new lifecycle generation.
- Timeout/cancelled/failed result events never remove the inbound message as a
  successful reply.

### Runtime reporting truth

After focused and real-process acceptance, Claude Code's Runtime reporter
availability may move from `contract_only` to `available`. Confirmation claims
remain false until service-side live evidence exists. The Reporter continues to
upload only privacy-safe phase, timestamps, stable error codes, and bounded queue
counts—never session IDs, prompts, replies, URLs, tokens, or raw WeChat identity.

## Authorization experience parity

### Two deliberately separate connections

1. **Attention MCP connection** — grants the user's Agent the same account-scoped
   cloud abilities as Web. Codex and Claude Code start this through their own MCP
   login commands, so the final loopback tab is host-owned.
2. **Device status sync (Runtime OAuth)** — optional, narrow scopes for device
   registration, heartbeat, binding report, and disconnect report. It never grants
   collection access.

CLI setup describes this separation in the same order and language for both
hosts. Runtime OAuth is recommended after MCP acceptance, not presented as a
prerequisite for local-only operation or cloud MCP use.

### Attention-owned completion page

The Runtime OAuth loopback callback replaces its current plain-text sentence with
a self-contained, no-network Attention page. It is host-neutral and follows the
committed Quiet Signal system: white canvas, neutral ink, Signal Blue, 16px card,
12px control, 44px action, visible focus, reduced-motion support, and mobile-safe
layout.

It distinguishes:

- authorization response received;
- authorization denied;
- invalid callback;
- malformed request or wrong route.

It never claims the connection is complete before token exchange and credential
persistence finish. It never renders code, state, token, client, installation,
device, or callback query data. Responses include `no-store`, strict CSP,
no-referrer, nosniff, and frame denial.

## UI audit and remediation sequence

### Phase A — read-only audit

After runtime and authorization implementation is complete, freeze UI source.
Run an Impeccable technical audit without editing production UI code. Cover:

- public discovery and locked-card states;
- login/registration module;
- account profile and collection views;
- every settings tab and connection-management modal;
- collect modal and feedback states;
- OAuth authorize, name conflict, replacement, cancel, and completion states;
- public Agent documentation;
- membership and checkout surfaces that exist in the first-release boundary.

Test authenticated/anonymous states, desktop, tablet, 390px mobile, 200% text
zoom where practical, keyboard-only navigation, reduced motion, and light theme.

The audit report lists every verified issue as P0–P3 with route, component,
file/line, category, user impact, violated DESIGN.md/WCAG rule, and a concrete
recommendation. It also records positive patterns and a 20-point health score.

### Phase B — design-system remediation

Only after the report is complete and saved may UI production code change.
Remediation fixes:

- every P0/P1 UI issue;
- every confirmed violation of committed PRODUCT.md/DESIGN.md rules;
- P2/P3 findings when the repair is local, low-risk, and testable.

Remaining non-blocking findings stay explicitly open in the report; none are
silently omitted. Fixes reuse existing components and tokens rather than creating
a competing design system. After fixes, rerun the same audit checks and publish
before/after scores.

## Acceptance gates

- Real local Claude Code 2.1.226 stream-json smoke: two turns in one PID, stable
  session, then process restart with resume.
- Resident protocol, lifecycle, timeout, crash, FIFO, and 20-turn fallback tests.
- Codex regression tests prove no capability or recovery loss.
- Codex and Claude integration projections expose the same Channel tool allowlist
  and Attention-owned OAuth sequence.
- Runtime callback semantic/security tests plus desktop and 390px browser checks.
- Full CLI/contracts/web typecheck, focused/full tests, lint, builds, public
  artifact checks, and `git diff --check`.
- Read-only audit report committed before any audit-driven UI remediation commit.

## Non-goals

- Making Codex and Claude internal protocols identical.
- Intercepting host-owned MCP OAuth callbacks or taking custody of host tokens.
- Uploading local conversation content for recovery.
- Expanding Claude tools beyond the six approved Channel capabilities.
- Introducing a second visual system during remediation.
