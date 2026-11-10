# Website Agent and shared Attention infrastructure

Date: 2026-11-10. Status: implementation candidate, opt-in multi-user rollout. Not deployed.

This extends the earlier release scope with an explicitly gated website agent.
It does not enable Hosted WeChat, migrate personal-agent sessions, or replace
the independent reader/browser isolation acceptance gates.

## One business/tool layer, two runtimes

- Personal agents keep their own runtime, model credentials, local files and
  conversations. They authenticate with OAuth/API Key to `/mcp`.
- The website agent uses a dedicated server-side DeepSeek credential and the
  native Pi Agent loop. The browser uses its existing website session to
  `/api/website-agent/query`; no OAuth/API Key is minted for the model.
- Both transports adapt `attention-tool-registry.ts`. Its strict schemas,
  scopes, Core services, owner checks, visibility, deduplication and tool-call
  audit remain authoritative. There is no second collection/search database.
- Source reads use the same owned `attention_read_collection_source` and
  isolated Fetcher. They never accept arbitrary browser credentials or a
  model-selected URL. Login, verification and safety failures remain stops.

The website adapter holds only the current authenticated account, session UUID
(not session token), scopes and explicit per-request capabilities. Identity,
model, endpoint, prior assistant messages and tool results cannot be supplied
in the request body. Authority is revalidated before every model dispatch and
tool call. Collection resolution additionally propagates cancellation and
rechecks permission before committing; cancellation before transaction return
rolls the transaction back. Cancellation cannot undo a committed save.

## Native Pi and the exact model

`packages/website-agent` uses released `@earendil-works/pi-agent-core` and
`@earendil-works/pi-ai`, and `@earendil-works/pi-coding-agent`, all pinned
to 0.85.1, plus TypeBox 1.3.7. The official 0.85.1 patch fixes 0.85.0
coding-agent root imports referencing an undeclared pi-server package. Native
AgentSession/SessionManager own session entries, branching, context replay and
compaction; Agent owns model/tool turns. The native DeepSeek provider owns
HTTP/stream conversion. No hand-written session format, context-trimming loop,
coding tools, shell, filesystem discovery or personal credential loading is used.

Official docs verified on 2026-11-10 identify API alias `deepseek-flash` as
DeepSeek V4.1 Flash, currently DeepSeek-V4.1-Flash-1017:

- https://api-docs.deepseek.com/api/list-models/
- https://api-docs.deepseek.com/quick_start/pricing/

The endpoint is fixed to `https://api.deepseek.com`. There is no model/provider
fallback, and no access to personal ChatGPT/Codex sessions. Thinking is disabled
for the initial integration. Private reasoning and raw provider errors are
never returned to the browser or saved in the admission ledger.

## Member capabilities and consent

`/agent/website` shows the console only to an enabled Member account. The
existing `/agent` page links to it only for those accounts. Each request
requires consent to send the question, necessary context from the selected
owned session, and account/collection information to DeepSeek. Source-body
reading is a separate opt-in. Users can create, select, reload and close their
own website sessions. Personal-agent conversations are never imported.
The rollout can target a restricted allowlist or every authenticated Member.
Neither mode grants anonymous/non-Member access or shares sessions across users.

The model can read the account's profile/membership, collections, status,
public feed, search and digest settings. Search uses deterministic retrieval
inside the existing registry: it cannot silently start a second AI provider.
When explicitly enabled in that form, the model may read eligible owned public
sources or save links from the exact original user message as private
collections. The server fixes the original message, retry key and private
visibility; the model cannot replace the input or publish it.
Automatic private collection is restricted to simple private create/reuse/
restore. If Core would preserve public visibility, merge/retire alias
collections, relink existing identities or change a shared Xiaohongshu source
URL, the website path fails for exact review and rolls its business transaction
back. Final authority uses a same-transaction, non-touching cookie check; it
never consumes a second DB connection while collection rows are locked.

All 16 canonical tool names have an explicit website transport policy. Reads
reuse the canonical live entitlement/scope checks, including Filter-only court
cases. Source reading still needs the separate opt-in; private collection still
uses only the original user message and its checkbox permission.

Visibility, report, vote and digest writes are proposal-only model tools. They
prepare an exact server-authored review card; no effect occurs until the user
checks the review acknowledgment and confirms that card through a same-origin
browser endpoint. The model cannot supply an approval flag, replacement args,
identity, scope or executable token. Reviews describe public, irreversible and
recurring consequences. Existing reports are identified as duplicates, never
falsely described as new submissions of changed details.

Public collection now prepares an exact source/effects review without publishing.
Ambiguous input presents server-owned choices and then a fresh one-candidate
review. A model candidate-selection call still returns a human-choice-required
gate and cannot submit a token as approval. The collection review shows the
persisted outbound destination after alias resolution, planned shared alias
edges, effective visibility, restored/deleted collections and job effects.

Shared enrichment now has its own evidence-bound review and execution path.
Only an actual ready/article read through the canonical reader in the current
website run can create an attestation. The host binds it to the account, auth
session, website session, run and revision, source operation and URL, extraction
method, text digest and actual read/observation times. Model-supplied references
cannot relabel a previous run's cached read. The attestation contains no article
body and expires within 120 seconds; action approval and execution deadlines
cannot outlive it. A source-read consent checkbox remains required.

The user reviews the complete title/summary/tags/final URL and the exact shared
identity, alias, collection restore/merge/delete, visibility, historical-result
and conditional notification effects. Existing publication-revocation markers
are preserved. An already-complete summary may still cause the separately
reviewed merge effects; it is never described as "nothing changed". Approval
performs no further source fetch or model call. It rechecks the stored evidence,
locks and reloads the exact target plan, then invokes canonical Core with a
trusted dependency override bound to that invocation's savepoint. Effects and
the receipt commit together, or roll back together. Expired, changed or unknown
actions do not automatically retry.

Every canonical tool has an execution path under its website consent, evidence
or human-selection policy; this is not unattended write permission for the
model. Every canonical tool must be classified; unknown future tools
fail closed instead of silently gaining authority.
Summarizing a successfully read source in the answer does not mark the shared
Core summary ready. Collection accepted, body read and summary ready remain
different facts. Multi-candidate collections stay pending for user choice.

## Native sessions and tenant isolation

Pi provides the existing session mechanism. Attention adds only account routing,
trusted external storage, authorization, retention, concurrency and usage checks.
`SessionManager.inMemory("/attention/website-agent", { id }, nativeEntries)` is
Pi's documented external/database persistence API. Native version-3 entries and
selected leaf are restored and saved unchanged apart from sanctioned pre-append
message transformations. Pi's AgentSession handles resume and compaction; there
is no custom conversation snapshot format or silent history trimming.

`website_agent_sessions` stores authenticated-encrypted native entries plus a
pending prompt. AES-256-GCM binds account, opaque random session UUID and revision
as additional authenticated data. The independent session secret cannot reuse
Auth/HMAC/provider keys. The model never receives it. Public API responses expose
only metadata, user/final-assistant text and pending status, never raw entries.

The application envelope reads versions 1 and 2; version 2 adds bounded,
encrypted action proposals beside the unchanged native Pi entries. These are
authorization metadata, not a second conversation or Pi session format. Each
proposal binds exact normalized argument hash, canonical contract, owner,
website/auth session, originating completed run, target fingerprint and expiry.
Public cards omit executable args, auth/claim IDs and source bodies; receipts
retain only status/code/message, never raw tool results.

Approval first commits a one-time executing claim. A subsequent account-locked
transaction reloads that exact claim, locks account/auth/capability and target
rows, resolves the real cookie on the same transaction without a lastSeenAt
touch, and invokes canonical Core under a savepoint. Non-ok results roll back
the savepoint. Current authority, wall-clock expiry and the exact target are
checked before effect/receipt commit. Effects and their receipt are atomic;
audits flush afterward using the root DB, not an expired transaction. Model
turns and actions share the durable account lane. Close, logout, target changes
and stale revisions fence execution. Uncertain claims become UNKNOWN and are
never automatically retried; reload only reconciles.

Every session read, write, close, reconnect, model call and tool call checks the
server-authenticated account. Owner RLS and a composite account/session run FK
provide database boundaries. A session header is not an ownership credential.
Expected revisions and an account advisory lock prevent overlapping turns and
stale completion after close or replacement. A successful answer is returned
only after its native session state commits. Crashed/expired pending turns are
recorded as interrupted without another paid call. Browser reload/status polling
never resumes a model or replays an effect automatically.

Session routes are `/api/website-agent/sessions`, `/sessions/:id` and
`/sessions/:id/close` under that API prefix. They use the website Cookie session,
not personal-agent MCP/OAuth credentials. Sessions close explicitly or expire
after seven idle days. Expiry is an access/lifecycle boundary, not a claim that
an automatic permanent-data purge has run.

The Pi message_end hook redacts tool bodies, tool arguments, intermediate prose
and reasoning before native persistence. Native tool receipts keep fixed
placeholders; only authorized current-run memory can hydrate original evidence
and arguments. Final answers and user prompts remain durable; quotations in a
final answer remain part of that answer. Historical tools never restore current
authority. Native compaction can use the persisted public conversation and
redacted receipts, not archived raw page bodies. Both split-turn summary calls
pass through the same permissions and usage guard. Native compaction does not
erase old entries: the archive has an explicit 512 KiB cap and reports
`session_full`, requiring a new session rather than silently deleting history.

## Admission, usage and operation safety

The strict body contains `query`, UUID `session_id` / `operation_id`,
`expected_revision`, `data_consent: true`, and optional `collect` /
`read_sources` booleans. No client history is accepted.
The handler checks same-origin/size limits, session, Member status and rollout
before any model call. The current audience and membership are rechecked before
every model/tool dispatch and after the final model response, before saving or
returning it. Session endpoints apply the same audience check, revalidate before
mutations after parsing, and withhold results if access changes while storage is
pending. Tool invocations remain sequential.

Each request has finite technical bounds: 6 model calls, 8 tool calls, 1,200
output tokens per call, 128 KiB context, 64 KiB per tool result and 60 seconds.
The result/context budgets accommodate a 12,000-character Chinese article.
Larger/multiple results fail explicitly instead of being silently treated as
complete. The browser supports stopping, repeated-click exclusion and ignores
late responses from an older or unmounted request.

Before starting, PostgreSQL atomically reserves the technical maximum under
an account advisory lock in `website_agent_runs`. Concurrent requests for an
account are excluded while a run is active. An account/operation uniqueness
constraint prevents a retry from starting paid generation again, including
after process restart. A HMAC fingerprint detects changed operation payloads.
No raw question, answer, source body, credential or reasoning is stored there.
Reservations are conservative and never automatically refunded after errors,
timeouts, crashes or uncertain effects.

Daily usage can be limited by the operator, or explicitly set to `unlimited`.
There is no implicit daily spending cap. The default 400,000 micro-USD per-run
reservation covers the maximum finite technical flow, rather than adding a
daily user cap. The Pi runtime separately reserves each outbound model call
using UTF-8 byte/token upper bounds and documented peak cache-miss rates
($0.30 input / $1.20 output per million tokens); invisible provider retries are
disabled. Reported usage/cost is an estimate, not a provider invoice or an
absolute guarantee if provider prices/accounting change.

Migration `0039_website_agent_budget.sql` adds the owner-RLS reservation table.
`0040_website_agent_sessions.sql` adds encrypted owner sessions and run ownership
constraints. Both grant only the required SELECT/INSERT/UPDATE runtime access.
Existing MCP schemas and business tables are not replaced. Apply the migration with the existing migration-owner
workflow before enabling the website agent; do not give that role to the web process.

## Configuration and rollout

Only the Web service receives these server variables:

- `ATTENTION_WEBSITE_AGENT_ENABLED=true`
- `ATTENTION_WEBSITE_AGENT_AUDIENCE`: `allowlist` (default) or `members`
- `ATTENTION_WEBSITE_AGENT_ACCOUNT_IDS`: exact comma-separated account UUIDs
  required in `allowlist` mode (1–100 unique accounts); must be empty/unset in
  `members` mode. A nonempty value with `members` is rejected, not ignored.
- `ATTENTION_WEBSITE_AGENT_DEEPSEEK_API_KEY`: dedicated server credential
- `ATTENTION_WEBSITE_AGENT_SESSION_SECRET`: independent stable encryption secret,
  at least 32 characters; keep it to resume existing encrypted sessions
- `ATTENTION_WEBSITE_AGENT_DAILY_COST_MICRO_USD`: positive integer or `unlimited`
- Optional `ATTENTION_WEBSITE_AGENT_MAX_RUN_COST_MICRO_USD` for a stricter run
  reservation, otherwise the technical bound above applies

`allowlist` preserves the restricted rollout when no audience is supplied.
`members` explicitly enables every currently authenticated Member without
maintaining an account list. It does not mean public access: every request still
requires the same current browser session and Member status. Session reads,
writes, native Pi history, tool access and budgets remain scoped to that account;
there is no shared session or cross-account access. A live switch from `members`
to an allowlist revokes excluded accounts at the next authorization check.

The feature is off by default and fails closed for incomplete/ambiguous
configuration, accounts outside the audience or unavailable admission storage.
Both audiences require dedicated credentials, a stable independent session
encryption secret, explicit daily-budget selection and finite per-run limits.
No credential is in source
or browser code. Keep keys in the deployment secret store/protected environment,
not a committed template. Docker copies the new package manifest; Compose
forwards these variables only to Web. No deployment is implied by these files.

The published Pi modules remain native Node externals in Next's production
build. Web declares the same exact `0.85.1` dependencies as the adapter so
Next/pnpm resolve them identically from the relocated application root.
The workspace TypeScript adapter remains transpiled. This avoids rewriting
Pi's dynamic Node loaders into webpack contexts. A copied standalone build
passed native Pi/DeepSeek imports and unauthenticated route smoke checks with
networking blocked and no deployment environment loaded.

## Verification evidence and remaining gates

Native Pi tests use actual Agent turns, synthetic tool data and fake native
streams; a mocked HTTP provider test validates exact model/endpoint, disabled
thinking, hard output caps and retry policy. Web tests cover consent, forged
context, auth, both audiences, rollout narrowing, revocation, admission, cancellation and private-save
capabilities. Schema/migration tests inspect RLS, uniqueness and explicit grants.

The authorized live smoke test used only synthetic status facts. `/models`
confirmed the exact alias and the balance endpoint reported funds available.
The real native Pi loop made 2 model calls and 1 synthetic tool call, with
855 reported input and 65 output tokens. Estimated peak-rate cost: $0.000336.
It correctly distinguished saved from body-read and summary-ready. This is
provider/tool-loop evidence, not evidence of live URL ingestion or production
Core/database behavior.

A standalone headless UI smoke fixture was prepared, but Chromium startup was
denied at Unix-domain socket creation before the page opened. A managed browser
also could not reach either the sandbox or approved shared-desktop localhost
fixture (`ERR_CONNECTION_REFUSED`); both fixture servers were stopped. No
supported private preview/port-forward route is exposed. Interactive browser
cancellation/repeated-submit/mobile rendering checks therefore remain
unexecuted; static form and state-helper tests are not substitutes for them.

The original local PG17 startup hit Unix-domain socket restrictions. After the
user completed Alibaba Cloud Workbench login, both 0039 and combined 0039/0040
fixtures passed on an explicitly disposable PostgreSQL 17.6 container with
network=none, no ports or persistent mounts and tmpfs-only data. Tests exercised
owner/cross-user RLS, runtime grants, composite ownership FK, revision/CAS,
lifecycle, constraints and rollback. Every synthetic change rolled back; the
exact test container and temporary SQL were removed. Production data, code,
services and schema were not changed. This is real SQL validation, not proof
that the complete Node admission path ran against that database.

A separate, explicitly authorized disposable Node/PostgreSQL acceptance run
then passed on Node 24.11.1 and PostgreSQL 17.6. It bundled the unchanged
application store, encryption, budget and Drizzle code with the actual native
Pi SessionManager. Fresh Node processes verified encrypted persistence/replay,
cross-owner application and runtime-role RLS denial, stale revisions, expired
lease recovery exactly once, close/cancel/late-finish fencing, concurrent
operation admission and non-refundable reservations. The fixture used only
synthetic accounts and exact 0039/0040 SQL; it did not run HTTP authentication,
provider calls, earlier migrations or a live schema upgrade. The source archive
was hash-verified in disposable container tmpfs, not deployed to the application.

A second authorized live synthetic smoke test exercised actual Pi 0.85.1
AgentSession/SessionManager across two turns and serialized native-session
reload. It made 3 model calls and 1 synthetic tool call, with 1,211 reported
input and 53 output tokens. Estimated peak-rate cost was $0.000428. The second
turn correctly recalled the earlier flags; a raw tool fixture marker was absent
from persisted native entries. No actual user content or business writes were
used. Native compaction has offline real-SDK tests; it was not billed in that
small live test.

Remaining release gates include authenticated full-HTTP integration,
interactive browser acceptance, rollout audience/ingress and final-commit CI.
The live checkout c0628d25 has two XHS/0.3.21 fixes beyond public main; their
source and immutable CLI bytes have been reconciled against verified live
hashes in this branch. Reverify the live target before replacement. The
application RC is `0.3.23-rc.1`, continuing after Attention 0.3.20 -> deployed
0.3.21 -> existing unpublished 0.3.22 without relabeling its separate CLI/Skill/
contract identities. See [version history](releases/2026-11-10-attention-version-history.md)
and [deployment mapping](releases/2026-11-10-application-deployment-mapping.md).
Migrations 0039/0040 change schema compatibility; the old 0038 app rollback
record alone is insufficient. Real platform-body acquisition and shared-summary
submission remain separate tests. Never use production for truncating suites.

## Exact collection and candidate reviews

Website collection uses the shared Core service, not another collection backend:

1. `resolveCollectionInput` reuses the normal extractor and Fetcher without database writes.
2. `loadCollectionEffectPlan` takes a bounded, SELECT-only snapshot. It binds the complete source identity/URLs, existing or absent identity/alias mappings, owner collection rows, restore/merge/delete effects, resulting visibility/moderation/domain, shared Xiaohongshu URL changes and metadata-job scheduling. It never stores article bodies or job payloads.
3. The website stores this prepared artifact inside its existing encrypted v2 action envelope. The human review shows its exact source and consequences. Public ambiguity creates only a pending candidate vault, never a public collection first. Private automatic collection keeps its existing no-public/no-merge fence.
4. The browser picks one of 2–16 server-owned options through the same-origin `actions/:id/select` endpoint. Selection replaces the options card with a new exact-action ID; it does not collect or approve. The selection token stays in the encrypted candidate vault and is removed from live model results. Action metadata contains only the owner/attempt/candidate/token-hash/vault-digest/visibility/expiry binding.
5. Approval obtains the existing durable one-time claim. Source re-resolution happens **after claim commit but before acquiring effect/authority locks**. Any changed source requires a new review. Once inside the transaction, a closure-backed `createAttentionToolRegistry(core)` invokes `establishPreparedCollection`; no model-supplied approval flag activates this path.
6. Core locks and compares the target snapshot, checks actual identity/alias/collection unique winners and job outcomes, consumes the candidate capability, and applies the normal collection code. The store commits its receipt in the same transaction. Cookie authority is rechecked using that transaction, including one-connection pools. Cancellation, expiry or mismatched effects roll back. Unknown outcomes are never retried automatically.

Candidate actions expire no later than their vault and the original choice card. Close, revision changes, another authentication session, a consumed token or an expired vault prevent selection/execution. Native Pi AgentSession/SessionManager remains the sole conversation/session implementation.

Offline coverage includes strict metadata/no-body parsing, source-change rejection, exact effective-public and merge review, model-token isolation, candidate HTTP guards and existing one-time action/store regressions. Guarded PostgreSQL cases in `tests/integration/website-agent-http.test.ts` and `collection-review-pg-cases.ts` exercise identity winners, alias drift, real merge/restore, candidate rollback/expiry, HTTP owner isolation, close, source changes, same-transaction receipts and one-connection final cookie checks. Playwright picker cases use the actual console component with synthetic HTTP responses. These guarded database/browser tests must run in the approved isolated CI environment; an offline unit pass is not evidence they executed.
