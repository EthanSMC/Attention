# Public Content Reading and Summary Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the existing Worker extraction fix and connect Worker, Bridge and future Hosted H2 to bounded, evidence-based public reading and honest recovery.

**Architecture:** A pure shared extractor and strict read contract feed a Fetcher read endpoint. Account-authorized Web/MCP gateways expose only collection-scoped reads; Bridge consumes trusted result events rather than guessing failures from prose. Anonymous rendering is an optional, fail-closed isolated backend, not general access to the user's browser.

**Tech Stack:** Existing Node >=24.0.0 / pnpm 11.9.0 / TypeScript / Vitest / Zod / Hono / PostgreSQL / Next.js. Preserve locked Readability 0.6.0 and LinkeDOM 0.18.13. Renderer uses an exact Playwright version matching its image; do not update the application's existing Playwright dependency as an unrelated change.

**Spec:** `docs/superpowers/specs/2026-09-07-public-content-reading-recovery-design.md` (approved 2026-09-07).

## Global Constraints

- 本次只做本地代码、测试和候选安装产物验证。不合并 main、推送、发布、部署、改变线上配置、替用户重新授权、重启用户服务或批量重放真实收藏。
- 本次不做登录态浏览器、Cookie 导入、验证码自动处理、付费内容读取、任意搜索、任意浏览器点击、用户端页面改版或数据库历史数据批量修复。
- Bridge 继续使用本地 Codex 生成摘要，不以配置 Hosted 模型或支付 Hosted 模型费用为前提。
- 静态读取沿用现有 8 秒总超时、最多 5 次重定向、2 MiB HTML 上限。
- 每次 `/v1/read` 总预算 90 秒；匿名浏览器页面执行最多 60 秒；HTML 提取快照仍最多 2 MiB。
- 浏览器每实例最多 1 vCPU、2 GiB 内存、256 MiB 临时磁盘、20 MiB 总网络响应流量。
- 服务端按账号和并发限制外网读取。初始限制为每账号同时 1 次、每分钟最多 6 次请求，单条 attempt 同时最多 1 次读取；全局浏览器最多 2 个。
- 正文最多 12,000 字符；截断必须标记。短期正文缓存最多 120 秒，每账号最多一份；数据库和审计不得保存正文。
- 三次内容恢复间隔为 2 / 10 / 30 分钟；依赖最多初次加 4 次恢复调用，5 秒 / 30 秒 / 2 分钟 / 5 分钟退避，整个周期最多 15 分钟。
- 用户查询状态只查询，不隐式再读取。明确“重试/补一下”才创建或提升原任务尝试。
- 新工具改变权限指纹时必须保留 consent_required；不通过伪造指纹、降低隔离或重置用户状态达成自动升级。
- Preserve the seven existing Worker-related modified/new files and unrelated `.codex/`. No reset, discard, broad cleanup, real account writes, credential output or production DB access.
- Read `apps/web/AGENTS.md` and the installed Next.js route-handler guide before editing Web code. Tests use isolated fixtures/DBs; no `.env` sourced implicitly.

## Execution and evidence

The existing checkout is on `codex/public-content-reading-recovery`, not main. Continue there if the user chooses in-place work; an additional worktree needs consent. Only one implementer writes at a time; reviewers are read-only. Each task owns its tests, focused verification, scoped commit and report.

Baseline: `pnpm exec vitest run apps/worker/src apps/fetcher/src tests/unit/collector --reporter=dot` passed 114 tests on Node 26.7.0. The app-bundled Node 24.19.0 failed before tests because macOS rejected a native module Team ID; do not disable signature checks or delete dependencies. Final acceptance still needs a compatible Node 24 runtime. Docker is absent from PATH; renderer isolation/live acceptance must remain explicitly unverified unless an authorized runtime becomes available.

### Task 1: Shared read contract, extraction classification, and Worker preservation

**Files:**
- Create `packages/content-reader-contracts/{package.json,tsconfig.json,src/index.ts,src/read-result.ts,src/read-result.test.ts}`.
- Create `packages/content-reader/{package.json,tsconfig.json,src/index.ts,src/document-extractor.ts,src/document-classifier.ts,src/document-classifier.test.ts}`.
- Preserve/move existing `apps/worker/src/document-extractor.ts` implementation with a compatibility re-export; preserve its current tests and production-handlers re-export.
- Modify `apps/worker/src/production-handlers.ts`, `production-handlers.test.ts`, `contracts.ts`, `handlers.ts`, `job-repository.ts`, `errors.ts`; Worker DB cases in `tests/integration/db-auth.test.ts` (failJob / reapExhaustedJobs).
- Modify package manifests, `pnpm-lock.yaml`, `tsconfig.base.json`, `vitest.config.ts`, root `Dockerfile` package COPY declarations, README only for this feature.

**Interfaces:**
Public exports from `@attention/content-reader-contracts`:
```ts
type ReadMethod = 'static' | 'browser';
type ReadFailureCode = 'reader_unsupported' | 'render_required' |
  'network_timeout' | 'dns_failure' | 'upstream_5xx' | 'rate_limited' |
  'source_content_pending' | 'login_required' | 'verification_required' |
  'access_denied' | 'source_not_found' | 'source_gone' | 'unsafe_source' |
  'permission_revoked' | 'content_ineligible' | 'evidence_insufficient' |
  'unknown_reader_error' | 'reader_not_configured' | 'browser_backend_unavailable';
type ReadRecovery = 'switch_reader' | 'retry_later' | 'needs_action' | 'pause' | 'stop';
type ReadFailureScope = 'reader' | 'source' | 'dependency' | 'security';
interface ReadAttempt { method: ReadMethod; duration_ms: number }
interface ReadMetadata { title: string | null; author: string | null;
  published_at: string | null; description: string | null }
interface ReadBase { schema_version: 1; request_ref: string; attempt_ref: string;
  attempts: ReadAttempt[] }
type ReadResult = (ReadBase & { outcome: 'ready'; evidence_kind: 'article';
  metadata: ReadMetadata; final_public_url: string; temporary_text: string;
  truncated: boolean; source_kind: string; extraction_method: string; read_at: string }) |
  (ReadBase & { outcome: 'blocked' | 'failed'; evidence_kind: 'metadata_only' | 'none';
  metadata: ReadMetadata; code: ReadFailureCode; scope: ReadFailureScope;
  recovery: ReadRecovery; retry_after_ms: number | null }) |
  (ReadBase & { outcome: 'skipped'; reason: 'already_ready' | 'not_eligible' });
```
Provide strict `ReadResultSchema`, `ReadRequestSchema` (trusted internal URL/sourceKind/attempt_ref), `readFailurePolicy(code)` and `isReaderFailureCode(value)`. Constrain enum-valued strings (source/extraction types), refs to safe identifiers of 1–128 chars, attempts <=2, finite duration/Retry-After and all string lengths. Forbid contradictory code/scope/recovery combinations; ready requires nonempty article evidence and safe HTTP(S) final URL without credentials. Export types derived from schemas rather than parallel definitions.

`@attention/content-reader` exports existing `extractDocument(html)` plus `classifyDocument(input: {html:string; status:number; finalUrl:string; sourceKind:string}): DocumentEvidence`. `DocumentEvidence` has `kind: 'article'|'metadata_only'|'blocked'|'empty'`, extracted metadata/text, `truncated`, `extractionMethod` and a nullable `ReadFailureCode`. No IO or executable page state in this package.

- [ ] **Step 1: RED classification and result validation.** Add literal fixtures for 200 challenge/login pages, metadata-only shell, short article discussing CAPTCHA, JSON-LD/body disagreement, body truncation. Mutation caught: treating every nonempty body or description as article evidence. Add schema tests rejecting ready+empty text, unknown codes, conflicting retry policies, excess attempts and raw exception fields.
```ts
expect(classifyDocument({status:200, finalUrl:'https://example.com/a',
 sourceKind:'generic_web', html:'<html><head><title>Verify you are human</title></head><body><main>Please complete the security check to continue.</main></body></html>'}))
 .toMatchObject({kind:'blocked', code:'verification_required'});
expect(classifyDocument({status:200, finalUrl:'https://example.com/a', sourceKind:'generic_web',
 html:'<article><h1>How CAPTCHA works</h1><p>CAPTCHA uses challenge-response tests. This article explains their accessibility costs.</p></article>'}).kind).toBe('article');
```
Run `pnpm exec vitest run apps/worker/src/document-extractor.test.ts packages/content-reader packages/content-reader-contracts --reporter=dot`; record expected feature failures before implementation.
- [ ] **Step 2: Implement pure schema/classification.** Preserve existing extraction behavior for real articles, separate meta description from body, classify before AI, use structural/page-level challenge signals not keyword-only rejection. Retain source/provenance and truncation. Export one shared implementation; keep worker import compatibility.
- [ ] **Step 3: RED Worker result safety.** Add tests that timeout/429 remain typed errors, metadata-only/challenge never call summary provider, and a reader failure exhausting a job does not set global unavailable. Add stale-job reap and ready/hidden race assertions in existing synthetic DB tests. Preserve existing unavailability behavior only for genuine terminal Core policy, not a single failed reader or missing model.
```ts
// Fixture loader returns a typed read failure; summary must not create fake evidence.
await expect(handlers.summary(context)).rejects.toMatchObject({code:'verification_required'});
// In the existing db-auth.test.ts synthetic PostgreSQL handle fixture:
const [row] = await handle.sql`SELECT summary_status FROM contents WHERE id = ${contentId}`;
expect(row.summary_status).toBe('pending');
```
Use existing handler/context and DB test helpers, not new production-only testing methods.
- [ ] **Step 4: Implement Worker adapter.** Keep existing static fetch envelope compatibility but retain target status, error class and bounded Retry-After. Use classifier for both metadata and summary. Update fail/reap paths with an explicit reader-failure classification guard, preserving ready/hidden and collection visibility. Do not rewrite historical rows. Extend internal result/error types only where consumed; compatibility change tested through consumers.
- [ ] **Step 5: GREEN and commit.** Run the original 114 tests plus new package/Worker tests; run affected types/lint/build. Dependency wiring uses pnpm, not handwritten lockfile entries. Stage only Task 1 paths, including the seven adopted files. Commit `feat(reader): preserve article evidence and classify read failures`. Record TDD commands/results and pending DB/runtime gates honestly.

### Task 2: Fetcher read orchestration and fail-closed anonymous renderer

**Files:**
- Create `apps/fetcher/src/{read-document.ts,read-document.test.ts,browser-reader.ts,browser-reader.test.ts,renderer-resource.ts,renderer-resource.test.ts}`.
- Modify `apps/fetcher/src/{index.ts,index.test.ts,safe-fetch.ts,safe-fetch.test.ts}` and package manifest.
- Create `apps/reader-browser/{package.json,tsconfig.json,src/protocol.ts,src/protocol.test.ts,src/runner.ts,src/runner.test.ts,Dockerfile}` and `deploy/reader/{README.md,seccomp.json}`; related build/package wiring.

**Interfaces:**
Consumes Task 1 schemas/classifier. Produces:
```ts
interface BrowserReader { read(input:{url:string; sourceKind:string; signal:AbortSignal}):
 Promise<{html:string; finalUrl:string; status:number}> }
function readDocument(input:{url:string; sourceKind:string; request_ref:string;
 attempt_ref:string; signal:AbortSignal}, deps:{staticRead:typeof safeFetch;
 browser:BrowserReader|null; now:()=>number}): Promise<ReadResult>;
```
Internal authenticated `POST /v1/read` accepts ReadRequestSchema and returns ReadResult. Preserve `/v1/fetch` exactly. New static response fields are additive. Cancellation propagates into safeFetch and body reading.

Renderer implementation decision: an OCI container with `--network=none`, non-root user, read-only FS, all capabilities dropped, no-new-privileges, bounded tmpfs/PIDs/memory/CPU, Chromium sandbox on. It communicates over bounded stdin/stdout JSONL, not an exposed browser port. Page resource requests are intercepted and relayed to a trusted parent that performs public-only pinned-DNS GETs and returns bounded bytes; the container cannot independently connect to the network. No user/host mounts, no secrets, no Docker socket in the renderer. The trusted launcher is operator-controlled and must not run inside Web/DB or accept arbitrary command/image arguments from requests. Operator configuration selects an immutable locally approved image digest.

Protocol frames: start `{kind:'start',url,sourceKind}`; resource `{kind:'resource',id,url,resourceType}`; response `{kind:'resource_result',id,status,contentType,bodyBase64}` or `{kind:'resource_error',id,code}`; final `{kind:'complete',html,finalUrl,status}` or `{kind:'failed',code}`. All fields/lengths/enums strictly validated. Parent uses safeFetch's URL/DNS/peer policy for every resource and redirect, sends no cookies or authorization headers, and caps 20 MiB across all frames, <=2 MiB snapshot, <=60 sec render. Only document/script/stylesheet/fetch/xhr GETs allowed; block images/fonts/media/downloads/popups/service workers/WebSockets/POST. Limit resource count to 100 and concurrency to 4 within one render. Child page text cannot select resource credentials or spawn commands.

- [ ] **Step 1: RED orchestrator.** Use a literal dynamic shell and synthetic BrowserReader returning article HTML. Assert the real readDocument result is article evidence, attempts are static then browser, and no second browser retry occurs. Assert 403/verification/unsafe URL never invokes browser; no backend returns browser_backend_unavailable with pause. Abort during static/render must abort and release resources.
```ts
const result = await readDocument(request, {staticRead:async()=>shellResponse,
 browser:{read:async()=>articleResponse}, now:()=>100});
expect(result).toMatchObject({outcome:'ready', attempts:[{method:'static'},{method:'browser'}]});
```
- [ ] **Step 2: Implement endpoint/orchestrator.** Route authentication/body bounds reuse index.ts helpers. Preserve stable Fetcher error codes and add typed target HTTP handling, Retry-After parsing (delta seconds and HTTP-date), total timeout and final URL validation. Only render_required / reader_unsupported / evidence without site refusal can switch. Mark unknown errors unknown; do not log content/URL query.
- [ ] **Step 3: RED renderer boundary.** Test real protocol parser/launcher argument builder/resource broker for malformed JSON, oversize frames, duplicate IDs, arbitrary executable/image input, private resources, redirects to metadata IPs, DNS rebinding, resource count/byte caps, cancellation and cleanup. Test runner against a controlled synthetic HTML+JS article, not a hostile live page outside isolation.
- [ ] **Step 4: Implement renderer and deployment contract.** Use existing exact Playwright 1.62.0 dependency or verify a matching exact renderer-only version against official docs; image build installs matching browser assets. No `--no-sandbox`, `--privileged`, host network/IPC, or SYS_ADMIN. OCI runtime absence or unvalidated configuration fails closed. Runtime configuration can be documented but must not be installed or activated on the user's host. Follow https://playwright.dev/docs/docker and https://playwright.dev/docs/network for API details; their general sample container settings do not replace this spec's stronger isolation.
- [ ] **Step 5: GREEN and gate.** Run Fetcher + protocol tests, types/build; if OCI available, run isolated dynamic article and negative network tests. If not, record exact missing runtime and keep backend disabled. Do not claim renderer acceptance from mocks. Commit `feat(fetcher): add bounded public reading with isolated render adapter` with status/evidence in report.

### Task 3: Collection-owned read gateway and shared coordination

**Files:**
- Create `apps/web/src/server/{collection-source-reader.ts,collection-source-reader.test.ts,source-read-coordinator.ts,source-read-coordinator.test.ts}`.
- Modify `fetcher-client.ts`, `attention-tool-registry.ts`, registry tests, `mcp-tool-adapter.test.ts`, `collection-service.ts` only where needed for source revision.
- Create `apps/web/src/app/api/collections/[collectionId]/source-read/{route.ts,route.test.ts}`.
- Modify `packages/contracts/src/{attention-capability-manifest.ts,attention-tool-output.ts,index.ts}` and matching tests.
- Add DB coordination migration using the next free main-branch migration identifier (inspect journal before choosing; do not touch H1 worktree), schema/export/tests; update DB snapshot via existing migration generation pattern.

**Interfaces:**
`readCollectionSource(context, {collection_id,attempt_ref,client_context}, deps)` returns Task 1 ReadResult augmented with the owned collection_id for trusted Bridge correlation. Registry output schema strictly extends the result envelope. `deps.read` calls `/v1/read`; `deps.revalidate` uses existing Core status/auth resolution, not trust in model input.

Coordinator stores no body or URL: account ID, collection ID, operation/source fingerprint, owner nonce, lease deadline, minute bucket/count. DB time drives rate/concurrency; acquire atomically enforces 1/account and 6/minute. A completed response is cached only in bounded owner-process memory for <=120 sec. Same-process duplicates share in-flight work; another process receives bounded retry_after rather than duplicating reads. Expired owners cannot release a replacement claim. Revalidate immediately before cache return and after reading. Global browser slots live in shared coordination (2), not per-process counters. Each fetcher request has a trusted resource-scope grant/reference from the coordinator rather than trusting arbitrary account IDs from a client.

- [ ] **Step 1: RED authorization.** Spy below real gateway decisions and assert no outbound read for wrong account, insufficient scope, hidden/deleted content, reuse_summary, arbitrary extra URL. Revoke/remove during a delayed read and assert returned result has no text. Same fixture must pass through Web and MCP permission adapters.
```ts
const pending = readCollectionSource(context, request, dependencies);
await markOwnedCollectionHidden(); releaseFixtureRead();
expect(await pending).not.toHaveProperty('temporary_text');
expect(outboundRequests).toHaveLength(1);
```
- [ ] **Step 2: RED DB coordination.** Real isolated PostgreSQL: parallel callers for same account acquire one lease; second account independent; seventh request denied; stale owner cannot release new owner; duplicate request cannot bypass auth or limits; no body persisted. Unit tests cover local cache byte/TTL/eviction independently of PostgreSQL.
- [ ] **Step 3: Implement gateway and storage.** Reuse current getCollectionStatus decision and authoritative principal. Current API input strict UUID + safe attempt reference; request scope owns source revision/fingerprint. Do not hold DB transaction open across external reads. No H1 migration import and no production DB operations. Shared coordinator must be wired in production, not injection-only tests. Existing app context principal and DB RLS patterns remain binding.
- [ ] **Step 4: Wire Registry/Web/capability.** Add `attention_read_collection_source`, scope collection:read + active eligible account checks, annotations reflecting external read. Web POST uses session and Origin/CSRF guards. Output/audit encode stable fields only; never store temporary_text. Increment MCP contract compatibly from 1.6.0 to 1.7.0; old tools retain behavior. Old Fetcher 404 fallback may use `/v1/fetch` static read with Task 1 classification, explicitly without browser claims.
- [ ] **Step 5: GREEN and commit.** Run exact route/service/Registry/capability/DB tests, Web typecheck and lint. Assert both old clients and unauthenticated requests continue expected behavior. Commit `feat(mcp): expose authorized collection source reading`.

### Task 4: Bridge trusted read facts, bounded recovery and capability compatibility

**Files:**
- Create `apps/cli/src/channel/{read-attempt-control.ts,read-attempt-control.test.ts,reader-recovery.ts,reader-recovery.test.ts}`.
- Modify `brain.ts`, `brains/codex-resident.ts`, `brains/claude-resident.ts`, corresponding tests, `collection-reply-control.ts` as needed for correlation, `summary-retry.ts`, `state.ts`, `pipeline.ts`, `channel-command.ts`, `prompt.ts`, tests.
- Modify `brains/codex.ts`, `brains/claude-code.ts`, `mcp-readiness.ts`, `bridge-update-contract.ts`, `installations/v1/templates/restricted-profile.json` and capability/install tests to negotiate optional reading without treating old servers as globally broken.

**Interfaces:**
`ReadAttemptControl` contains owned collectionId, attemptRef, outcome, methods, failureCode, failureScope, recovery, retryAfterMs and no source text/URL. `applyReadToolResult(previous, toolName, payload)` accepts only validated responses to the exact new tool; BrainOutcome carries optional readAttemptControl. `readerRecoveryDecision(control, budget, now)` yields schedule/pause/stop/complete and updated finite counters; ready reading alone never yields summary complete.

- [ ] **Step 1: RED trusted event parsing.** Feed real host protocol event fixtures through Codex/Claude adapters. Assert new MCP tool gives control, unrelated/forged/raw text/mismatched collection results do not, and account/MCP errors retain existing independent recovery. Article text must not enter state or user replies.
- [ ] **Step 2: RED retry/state migration.** Literal timeline tests: static unsupported -> browser same attempt; rate limit honors next deadline; verification pauses without another timer; unknown gets one 2-minute retry; configured dependency max5 calls/15minutes; legacy paused job remains paused. Resumed old files retain budget; manual retry does not duplicate collection or reset unrelated timers. A read success followed by submit failure is not completion.
```ts
expect(readerRecoveryDecision(verificationControl, initialBudget, 0))
 .toMatchObject({action:'pause',nextAttemptAt:null});
expect(readerRecoveryDecision(rateLimitedControl, initialBudget, 1000))
 .toMatchObject({action:'schedule',nextAttemptAt:121000});
```
Fixture rateLimitedControl has retryAfterMs=120000; expected values are literals independent of production builders.
- [ ] **Step 3: Implement controls and persistence.** Schema-normalize new state, version/backup compatibly; active migrated legacy jobs get new classification at next authorized execution, not a reset. Correlate current collection and attempt; don't parse AI prose. Integrate with MCP/brain dependency supervisor so timers don't overlap or loop forever. Existing queue bounds and cancellation survive.
- [ ] **Step 4: Update prompts/capability/session behavior.** New server: use restricted tool; old server: plain chat/collect still available, explicitly absent reader, bounded unknown fallback. Tool list/profile remain Attention-only; never re-enable shell/browser/plugin features. Distinguish user status query from explicit recovery, and generate AI text from actual task facts. Permission fingerprint updates require existing consent; after accepted update old session is rebuilt using current fingerprint while account/retry state is preserved. Do not restart live service in tests.
- [ ] **Step 5: GREEN and commit.** Run CLI channel focused suite, profile/update/state tests and typecheck/build. Commit `fix(bridge): recover summary reads using trusted failure facts`.

### Task 5: Integrated candidate artifacts, H2 mapping and acceptance record

**Files:**
- Modify CLI version/manifest/install artifacts only via existing scripts, `README.md`, `docs/public-content-reading-recovery-status.md`.
- Create `tests/integration/public-content-reading-recovery.test.ts`, `scripts/check-public-reader.ts`, `docs/handoffs/hosted-reader-contract.md`.
- Update root Dockerfile/package COPY wiring and validation tests if newly needed, without modifying live Compose environment values.

**Interfaces:**
Consumes Tasks 1–4. `check-public-reader.ts --url <public-url>` performs read-only anonymous checks with explicit configuration, prints only status/classification/method/length and exits nonzero if article evidence not acquired. It never collects, submits enrichment, emits page text or sends WeChat messages. H2 mapping converts ReadResult into existing stage/failureCode/needs_action/waiting_dependency semantics without importing or merging H1 DB migrations.

- [ ] **Step 1: RED integrated fixture.** Exercise synthetic owned collection -> authorized read -> article evidence -> deterministic fake model -> real conditional Core write -> Bridge success fact; duplicate run produces one collection/effect. Add dynamic shell, verification, no reader, cancellation, and out-of-order result paths. Use isolated database/principal fixtures only.
- [ ] **Step 2: Candidate version and sync.** Read current version and unoccupied candidate filenames before assigning the next patch; use existing release scripts. Run capabilities:sync/check, agent-installations:sync/check and cli-artifact:sync/check. Permission hashes must change consistently and existing installer returns consent_required. No online latest update, global CLI installation or push.
- [ ] **Step 3: Read-only real samples.** Run approved anonymous static reader on user's WeChat URL and existing MDN/GitHub samples. Browser live sample only after isolated renderer gate. Record separate outcomes; don't replace the WeChat target or claim extraction if no body returned. Keep raw real pages out of repo/logs.
- [ ] **Step 4: Full acceptance.** Run root tests, all typechecks, affected lint, Worker/Fetcher/Web/CLI builds, isolated DB regression, artifact checks on a Node24-compatible runtime. Root commands: `pnpm test`, `pnpm typecheck`, `pnpm exec eslint <changed-ts-files>`, `pnpm build`, and the three artifact check scripts. Do not claim a skipped DB/browser suite passed.
- [ ] **Step 5: Whole-branch review and handoff.** Independent final review after per-task gates; one consolidated fix wave as prescribed by SDD. Persist status, unresolved environmental gates and H2 mapping. Keep feature branch; no main merge/push/deploy. Commit `test(reader): validate integrated recovery and candidate compatibility` only after recording exact passing and unverified checks.

## Plan self-review coverage

Spec 1–3 -> all task constraints and Task1 preservation; 4 -> Task3; 5 -> Task1; 6 -> Task2; 7 -> Task4; 8 -> Task1/3; 9 -> Task3/4; 10 -> Task3/4/5; 11 -> Task5; 12 -> task RED/GREEN + Task5 gate; 13 -> user go recorded in spec. Browser deployment and real isolation are gates, not mocked completion. Shared interfaces are defined here and in Task1 exports; later implementers must consume actual exports and report drift before editing other task ownership.
