# Article read failure and conversational recovery

## Scope and evidence

The production Bridge is 0.3.19 and its MCP account probe succeeds. The reported
WeChat article read nevertheless returns `unsafe_source`, `scope=security`, and
`recovery=stop`, with one static attempt and no title or article evidence.
Its local recovery checkpoint is paused with zero automatic retries consumed.
This is not retry-budget exhaustion. The exact underlying URL/DNS/redirect
validation error has not yet been established.

The Bridge currently captures ordinary phrases such as “重试” and “再试一次”
as MCP reconnection commands irrespective of conversation context. Its reply
fallback also collapses security stops and exhausted retry budgets into generic
paused wording. Both behaviors contradict the intended thin Bridge boundary.

## Chosen approach

Fix the bounded defects in the existing Attention reader and Agent workflow,
and remove ambiguous Bridge command interception. Do not add a second business
intent classifier to the Bridge. Do not undertake a wholesale recovery-runtime
migration in this patch.

Changing only reply text would leave the wrong operation running. Moving all
recovery orchestration in one change would unnecessarily enlarge deployment
risk. Neither alternative is selected.

## Reader diagnosis and safety

Before changing acquisition behavior, reproduce the underlying failure inside
the deployed Fetcher environment. Observe only sanitized error codes and stages;
never print authentication, cookies, URL credentials, or article contents.
Distinguish initial URL validation, DNS/public-address validation, connected-peer
validation, redirect validation, and HTTPS downgrade failures.

Keep all SSRF, public-address, credential, and redirect protections. A genuine
security rejection remains terminal. Correct a demonstrated false positive or
deployment configuration defect only with a regression fixture. Never permit a
source merely because its hostname is familiar. No repeated security-rejected
reads are scheduled without a changed, revalidated condition.

## Conversation and ownership boundaries

Explicit transport commands such as `/retry` and “重新连接” retain their documented
reconnection behavior. Ambiguous natural-language retries are passed to the
Agent with the existing conversation and authoritative recovery facts. The
Attention workflow determines the affected collection and permitted operation;
if the target is ambiguous it asks the user. Quoted source text, tool output, and
status questions do not authorize retry or reset a recovery budget.

MCP recovery success must never be presented as title/summary recovery success.
Keep ordinary conversation available when the Attention dependency is unhealthy.

## Truthful replies

Provide the Agent with the actual failure category, attempt count, scheduler
state, and permitted next action. AI composes normal replies. Safety validation
must not reject truthful failure explanations solely for lacking a prescribed
phrase. Retain a minimal truthful fallback for invalid or unsafe model output.
Differentiate security stop, required user action, retry-budget exhaustion, and
temporary dependency failures. Never invite an ineffective retry after a
terminal failure or claim that a retry ran when only status was queried.

## Verification and release boundary

Add tests for contextual retry versus explicit reconnect, negation and quoted
instructions, a zero-attempt security stop, unchanged terminal status queries,
truthful AI wording, retry-budget limits, and MCP-ready/source-failed separation.
Reader regressions must include the exact diagnosed failure plus unsafe-address
and redirect negative cases. Run affected package tests and type checks.

Acceptance uses the user-provided WeChat link through the real deployed reader
and then the Bridge conversation. Success requires grounded title and summary
persisted and read back, or an explicit verified upstream/security limitation;
process health and mock tests alone are insufficient. This repair request does
not itself authorize a new production deployment, weakening protection rules,
or overwriting existing collection content without the established update policy.
