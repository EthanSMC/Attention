# Attention website agent

A server-only, bounded conversational runtime built on native Pi `Agent`,
`AgentSession`, and `SessionManager`, and the native DeepSeek provider. The three
Pi packages are pinned to **0.85.1**. Version 0.85.0's coding-agent root import
referenced an undeclared `@earendil-works/pi-server` dependency; the official
0.85.1 release removes that broken eager import. No private deep imports,
vendored runtime, package shim, or substitute session implementation is used.

## Contract

`runWebsiteAgent({ prompt, apiKey, tools, limits, signal?, nativeSession?, compact? })`
returns `{ answer, toolReceipts, usage, nativeSession }`. Each invocation accepts
one new user prompt and optional **server-loaded** native session entries. Never
accept client-supplied history, native entries, system prompts, tool results,
model overrides, or injected streams. `beforeModelCall(signal)` revalidates live
session/membership before **every** provider dispatch, including compaction,
and fails closed with `permission_revoked`. `streamFn` is a trusted server/test
injection for native Pi streams. Production exclusively uses the native
DeepSeek provider at `https://api.deepseek.com`, model ID `deepseek-flash`.

Every tool has `name`, `description`, an object `inputSchema` (JSON Schema), and
`invoke(input, { signal, toolCallId })`. Schemas are copied and strictly checked
before native Pi validation. Tools run sequentially. Domain authorization and
input/output contracts remain the trusted adapter's responsibility. This package
provides no authenticated identity or policy bypass. Do not register consequential
mutation tools without a separate explicit approval path.

Responses expose public final text, minimal execution receipts, and usage
estimates. Receipts contain no tool inputs or result bodies. `WebsiteAgentError`
exposes a stable `code`, sanitized `message`, `usage`, and `toolReceipts`, including
`unknown` for interrupted effects. Cancellation is propagated but cannot undo an
external effect or force an uncooperative adapter to stop. Adapters must honor
`AbortSignal`.

## Native per-user sessions

The host owns authentication, ownership, session creation/deletion/expiry,
per-session concurrency, and transactional revision control. Load entries only
after resolving the session under the authenticated account, then atomically
save the returned entries with the expected revision after success. The native
header ID must equal the opaque database session UUID. A native header is not
proof of ownership. No account/session cache is shared between runs.

The persistence envelope contains Pi's native version-3 `FileEntry[]` and selected
`leafId`. `SessionManager.inMemory("/attention/website-agent", { id }, entries)`
is Pi's documented API for externally stored session entries. The package uses
native branch selection and `buildSessionContext()` for replay, and native
`AgentSession.prompt()` for each new turn. No custom message trimming, snapshot
conversation format, or alternative summarization implementation is used.

Exported host helpers:

- `createNativeWebsiteSession(id)` creates a native session with the database UUID.
- `parseNativeWebsiteSession(value, expectedId)` validates and copies stored JSON,
  including the native header, entry graph, permitted content, metadata, and cap.
- `appendInterruptedNativeWebsiteSession(session, prompt, statusText)` uses native
  append methods to record the exact prompt and an authoritative interruption
  notice, without a model call. It must not invent completed effects.
- `assertNativeWebsiteSessionContinuation(prior, next, prompt, answer?)` checks an
  append-only continuation, unchanged prior entries, exact prompt, and final answer.
- `websiteAgentSessionMessages(session)` projects user/final-assistant messages
  from the full selected branch for the UI. Compacted archive messages remain
  visible; model replay still uses Pi's native context builder.

The native archive is capped at **512 KiB** serialized UTF-8 JSON and 4096 entries.
The runtime reserves room before dispatch and fails closed with `session_full`
when there is insufficient space. Start a new session at that point. Compaction
adds checkpoints; it does **not** erase or shrink the persisted archive.

### Safe native persistence

An explicit resource loader supplies only the server system prompt and a local
`message_end` safety extension. Native coding tools, filesystem sessions,
resource/extension/skill discovery, and credential-file loading are not enabled.
`SettingsManager`, model credentials, model cache, and `SessionManager` are
in-memory. Model network discovery is disabled. The synthetic cwd is not read.
Tools are rebuilt from the current server allowlist for every run. Historical
messages, tool names, or summaries never grant authority or restore old tools.

Pi's supported `message_end` transformation runs **before native persistence**.
It removes reasoning, intermediate tool-turn prose, and tool arguments. Native
tool-result entries retain only a fixed redaction notice, name, call ID, and
error flag. Tool-call arguments persist as `{}`. Current-turn arguments are
restored via a per-run WeakMap before native validation/execution; raw tool
results and assistant tool context are hydrated only for the current authorized
run. These transient values are cleared after completion/cancellation. Old
sessions cannot restore them, and historical call IDs cannot be replayed.

Only user prompts and public final answers retain their text. Source references
or quotations deliberately included in the public answer remain durable. Native
compaction can summarize that public text and redacted receipts, not raw tool
bodies or private reasoning. Invalid roles, custom entries, unknown metadata,
raw result bodies, non-redacted arguments, and unexpected model/provider fields
fail closed. Failures return no new native session; the host can append a factual
interruption notice to the last committed native session.

### Native compaction and budgets

The host-only `compact` flag requests native `AgentSession.compact()`. The runtime
also requests native compaction when prior context exceeds half the configured
application context-byte limit, before the smaller application guard is reached.
Pi's native auto-compaction remains enabled. Pi chooses the cut point, generates
the summary, appends its native checkpoint, and rebuilds context. A split turn can
require **two** summary calls. All summary calls pass through the same guarded
stream as ordinary chat: permission revalidation, cost reservation, model-call
limit, provider/output/context limits, cancellation, and timeout. Native session
retries and provider retries are disabled. A failed compaction never silently
falls back to dropping history or an unbudgeted call.

## Exact DeepSeek model

Official docs checked on 2026-11-10 identify `deepseek-flash` as DeepSeek V4.1
Flash (current release DeepSeek-V4.1-Flash-1017), with a 1M-token context:

- https://api-docs.deepseek.com/api/list-models/
- https://api-docs.deepseek.com/quick_start/pricing/

The SDK catalog need not contain this new alias: an explicit custom native model
is provided. No fallback to `deepseek-chat`, another model, or another provider
is allowed. The alias may evolve upstream; it is not an immutable model snapshot.
Thinking is explicitly **disabled** for this first integration to avoid DeepSeek
reasoning replay protocol issues during tool calling. Any unexpected native
thinking blocks are omitted from replay and the returned answer.

## Budgets and operational boundaries

All six limits are required: `maxRunCostMicrousd`, `maxModelCalls`, `maxToolCalls`,
`maxOutputTokensPerCall`, `maxContextBytes`, and `timeoutMs`.
Optional byte limits default to 16 KiB tool inputs, 32 KiB tool outputs, and 32 KiB
final answers. Hard application ceilings include 16 model calls, 32 tool calls,
8192 output tokens per call, 900,000 context bytes, and 120 seconds per run.

Before each model call, the runtime reserves a conservative maximum using one
input token per serialized UTF-8 byte, plus framing/schema overhead, and the
entire output-token allowance. The actual provider payload is checked again
before submission. Rates are the documented peak cache-miss **$0.30 input and
$1.20 output per million tokens**. Cache discounts are not assumed. Provider
retries are disabled so an invisible retry cannot incur an unreserved request.
Provider `max_tokens` is always explicitly set. Reservations are cumulative and
are never automatically refunded based on partial, absent, or apparently cheap
provider usage. `reservedCostMicrousd` is the attempted-call reservation maximum;
`observedCostMicrousd` is only an estimate from provider-reported usage, not a bill.

This is an application guard, not an absolute provider billing guarantee:
provider token accounting, rates, and behavior can change. The hosting backend
must atomically track a per-account run reservation before calling this runtime,
honor the configured daily limit or explicitly selected unlimited daily policy,
handle rate/concurrency limits, and fail closed if budget state is unavailable.
Account reservations should not be refunded automatically after uncertain
outcomes. This package performs no durable financial accounting.

## Verification

Tests inject native `AssistantMessageEventStream` values through the actual Pi
Agent loop, and mock HTTP for the production native DeepSeek provider. They
exercise tool order/allowlists, malformed arguments, all major budgets,
provider/tool failures, cancellation, missing answers, reasoning exclusion,
native session creation/resume/checkpoint reload, strict graph validation, archive
bounds, compaction accounting, and concurrent owner-session isolation.
These automated tests use no live paid model calls or real credentials. Separately
authorized synthetic live smoke results are recorded in the architecture document.
