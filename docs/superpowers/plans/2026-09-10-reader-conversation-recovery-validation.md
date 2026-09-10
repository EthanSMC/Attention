# Reader conversation recovery — implementation and validation

Date: 2026-09-10

Approved design: `../specs/2026-09-10-reader-failure-conversation-recovery-design.md`.

## Confirmed live cause

A read-only request from the deployed Fetcher received HTTP 302 from the user-reported WeChat article. The redirect remained on `https://mp.weixin.qq.com`, with path `/mp/wappoc_appmsgcaptcha` and query keys `poc_token` and `target_url`. No redirect was followed; no token values, cookies, article body or authorization data were retained in this report.

The prior URL credential guard classified this redirect as `unsafe_source` / `stop`. This is an upstream verification requirement, not evidence of an MCP outage. Reconnecting MCP does not resolve it.

## Implemented changes

- Ordinary conversational retry requests reach the Agent for contextual interpretation. Explicit `/retry` and reconnect commands retain local connection recovery. MCP guidance now consistently asks for “重新连接”.
- A narrowly recognized, same-origin WeChat challenge in document-read mode returns `verification_required` / `source` / `needs_action`. It is a refusal classification, not a URL allowlist. The challenge is never fetched; metadata mode and unrecognized redirects retain existing safety checks.
- Stored read failure/recovery facts survive status-only follow-ups. A paused scheduler job is not reported as exhausted retries without evidence.
- Safe, truthful AI explanations are retained. Settled automatic attempts reuse the existing model reply and sensitive-fragment guard rather than making another model call. Deterministic fallback explains verification/security constraints when needed.
- Existing finite retry budgets, status-only read restrictions and legacy-server authorization boundaries remain in place.

## Validation

The original worktree has cloud-offloaded files and Git initially reported an unavailable pack as too short. Subsequent hydration read all 816221 bytes; the pack checksum and Git verification passed, confirming this was an offloaded-file availability issue rather than demonstrated corruption. Its dependencies also failed to load reliably. Validation therefore used a clean, isolated clone at base `c584bba8744f24af42a206a533a791586b8b737e`, with only this repair copied in and dependencies installed with the frozen lockfile.

Validation workspace: `/private/tmp/attention-recovery-verify-aYHcez/repo`.

- CLI, Fetcher, content-reader and content-reader-contracts: **59 test files, 800 tests passed**.
- CLI TypeScript check: passed.
- Fetcher TypeScript check: passed.
- CLI and Fetcher production builds: passed.
- Initial built CLI `--version` smoke test passed on the development base; release preparation advances both package and runtime identity to `0.3.20` and regenerates the public artifact and manifest without changing immutable `0.3.19` downloads.
- `git diff --check` in the validation clone: passed.
- Tests cover ordinary versus explicit reconnect routing, persisted stop facts and unchanged budgets, AI pause replies with one model invocation, verification classification, no challenge fetch, and rejection of foreign origins, credentials, ports, fragments, extra credential parameters and duplicate tokens.

Reproduction commands (from validation workspace):

```sh
node apps/cli/node_modules/vitest/vitest.mjs run apps/cli/src apps/fetcher/src packages/content-reader/src packages/content-reader-contracts/src
node apps/cli/node_modules/typescript/bin/tsc --noEmit -p apps/cli/tsconfig.json
node apps/fetcher/node_modules/typescript/bin/tsc --noEmit -p apps/fetcher/tsconfig.json
pnpm --filter @attention/cli --filter @attention/fetcher build
```

## Release and remaining limits

No schema migration or wire-contract change is needed: `verification_required` already exists in the reader contract. Both the Fetcher and Bridge source fixes must be included in a subsequent release for the complete behavior. Do not replace an existing immutable 0.3.19 download with these development builds; assign a new CLI/Bridge release version and regenerate its release manifest using the established release process.

At initial validation, no merge, push, package publication, deployment or local Bridge replacement had been performed. The user subsequently authorized PR, merge and deployment after Git hydration. Existing worktree and unrelated files are preserved; no Git reset or destructive repair is needed. Final release/deployment outcomes must be recorded separately rather than inferred from this local validation report.

The upstream server-side verification requirement still prevents successful article reading in the observed environment. This work does not claim a successful live title/summary enrichment or a deployed WeChat end-to-end pass. After release, verify conversational retry routing and factual failure explanation in WeChat; successful enrichment additionally requires a permitted source-reading path that actually returns the article body. Mobile verification alone is not proof that the server's reading environment has been cleared.
