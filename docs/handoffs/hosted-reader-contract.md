# H2 public-reader adapter contract

This is a future task-scoped adapter specification, not a Hosted runtime implementation or acceptance claim. This branch imports no H1 task package or DB migration. The existing Hosted design's Core grant/lease/epoch rules remain required before an H2 consumer can execute.

Input is a strict `ReadRequest`; output is validated `ReadResult` from `@attention/content-reader-contracts`. The trusted gateway derives URL, source kind, account and collection from current Core ownership and eligibility. The task scheduler binds request/attempt references to the active task attempt; model input never grants browser capacity or contains credentials. Reject mismatched references/source kind, stale task revision, grant epoch or fence before using evidence. A transport failure with no validated envelope has unknown attempt history (`null`), never fabricated static/browser attempts.

| Reader fact | Future task mapping | Required decision |
| --- | --- | --- |
| `ready`, article evidence | Running stage `reading` → `summarizing` | Temporary evidence only; not `completed` or `summary_ready` |
| Generated summary | Running stage `committing` | Recheck current grant, entitlement, collection, epoch and lease fence in the same Core transaction as effect receipt/result event |
| Core `enriched` / `already_enriched`, or authoritative reusable summary | `completed` | One Core business effect; notification delivery remains independent |
| `retry_later`, dependency scope | `waiting_dependency` | Save exact failureCode, actual attempts and bounded next execution only after scheduling commits |
| `retry_later`, source-content pending | `retry_scheduled` | Consume content recovery budget; preserve existing active counters/deadlines |
| `retry_later`, reader/unknown error | Actual reader dependency policy | At most one bounded dependency cycle; unknown methods stay unknown |
| `switch_reader` | Continue `reading` only with a distinct admitted reader | No repeated same-reader loop; exhausted/unavailable reader becomes `paused` |
| `needs_action` | `needs_action` | Explain known login/verification/authorization cause; anonymous reader cannot inherit user-browser verification |
| `pause` | `paused` | No automatic timer even if this code permits retries in other contexts |
| `stop` | End current source attempt (`failed` or confirmed `cancelled`, according to task cause) | Preserve saved Core content; no delete/hide or fabricated completion |
| `skipped:already_ready` | Recheck Core, then reusable completion | Reader skip alone is not a new summary write |
| `skipped:not_eligible` | End current source attempt | Preserve saved content and report authoritative eligibility fact |

Every `/v1/read` has a 90-second total budget, at most one static attempt and one anonymous browser attempt; browser execution is at most 60 seconds. Static limits remain 8 seconds, five redirects and 2 MiB HTML. Browser limits: 1 vCPU, 2 GiB RAM, 256 MiB temporary disk, 20 MiB total response traffic. Browser dispatch requires separate trusted one-shot admission; shared-secret authentication alone is insufficient. Account limits are one concurrent read and six invocations/minute, one read per attempt, with at most two browsers globally.

Text stays transient: at most 12,000 characters with explicit truncation, maximum 120-second cache with one entry/account. No original text in DB, audit, persisted task facts, logs or replies. Submit only the established Core enrichment fields. `ReplyFacts` may contain safe task stage, stable failureCode, actual persisted schedule and completion confirmation. Query-only messages perform no read/retry; “running” requires a valid executing lease, “scheduled” a saved schedule, and “completed” a Core receipt. Page data never directs tools, authorization or routing.

Content recovery has three further attempts after 2/10/30 minutes. Dependency recovery has at most four further calls after 5 seconds/30 seconds/2 minutes/5 minutes, within 15 minutes; respect Retry-After and pause when it exceeds the remaining window. Explicit recovery can start a new bounded cycle for a paused task, while an active cycle retains counters/deadline and unrelated jobs remain intact. Cancellation aborts reads/model calls and rejects late results; only confirmed stop permits `cancelled`. Out-of-order results cannot commit across an epoch/fence or replace a newer task fact.

Before H2 release, separately verify task-scoped Hosted delegation (MCP OAuth is not that grant), same-transaction Core receipt fencing, cancellation races, restart recovery, notification target isolation, actual OCI renderer limits and network policy. This branch's isolated Core/reader/Bridge tests do not establish those future Hosted runtime gates.
