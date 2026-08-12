# Local Agent Content Enrichment Design

Date: 2026-08-12
Status: Approved for implementation planning

## 1. Outcome

Attention saves a link before enrichment. A local Agent that has public-network
access supplies the first missing summary and tags through MCP. The summary is
shared by the deduplicated Content, while each user's Collection independently
controls whether its card is private or public.

Hosted AI is not a first-release dependency. The existing OpenAI-compatible
adapter is implementation scaffolding, not a deployed product capability. A
missing Hosted AI configuration must therefore never turn an otherwise valid
Content into a terminal summary failure.

## 2. Product invariants

1. `Content` owns the shared summary and tags.
2. `Collection` owns account attribution and private/public visibility.
3. Member and Filter roles do not change summary visibility or ownership.
4. If a Content already has a ready summary, every later collection reuses it.
5. If a Content lacks a summary, the collecting local Agent may generate and
   submit one after reading the public source.
6. The first valid concurrent submission wins. Later submissions do not
   overwrite it and receive an `already_enriched` result.
7. Agents submit only summary and tags. Fetcher remains responsible for title,
   author, publication time, URL safety, resolution, and source metadata.
8. Agents never upload copied full text, cookies, authorization headers,
   browser state, or private-page material.
9. A summary remains `pending` while no enrichment source has completed. It is
   not `unavailable` merely because Hosted AI is disabled.
10. Metadata completion must never overwrite a summary result written by a
    concurrent enrichment operation.

## 3. Considered approaches

### 3.1 Two-step collection and enrichment — selected

The Agent first calls `attention_collect_content`. Deduplication happens before
the server tells the Agent whether it should generate a summary. Only when the
response requests enrichment does the Agent read the page and call a second
tool.

This avoids wasted model work for already-enriched Content, works after
ambiguous candidate selection, and gives the server an atomic concurrency
boundary.

### 3.2 Upload enrichment with the initial collection — rejected

This makes every Agent read and summarize before it knows whether the Content
already exists. It also complicates ambiguous share text and wastes local
inference.

### 3.3 Server dispatch to an online local Agent — deferred

This would require device selection, offline delivery, task leasing, and
cross-device routing. It is unnecessary for the first release because the
Agent that initiated collection can perform the enrichment inline.

## 4. MCP contract

### 4.1 Collection response

Every established result from `attention_collect_content` and
`attention_select_collection_candidate` adds:

```json
{
  "summary_status": "ready | pending | unavailable | hidden",
  "enrichment_action": "reuse_summary | generate_summary | none"
}
```

Mapping:

- `ready` -> `reuse_summary`
- `pending`, `failed`, or legacy `unavailable` with no stored summary ->
  `generate_summary`
- `hidden` or ineligible Content -> `none`

The response does not return the full summary because the collection result is
an action protocol, not a read API. Existing list/status tools remain the
source for stored Content details.

### 4.2 New tool

Add `attention_submit_content_enrichment` under the existing
`collection:write` scope.

Input:

```json
{
  "content_id": "uuid",
  "summary": "non-empty string, at most 2000 characters",
  "tags": ["1-8 unique non-empty strings, each at most 64 characters"],
  "idempotency_key": "opaque stable key",
  "client_context": "existing Attention client context"
}
```

Output:

```json
{
  "content_id": "uuid",
  "status": "enriched | already_enriched",
  "summary_status": "ready"
}
```

The service must return the same successful semantic result when a response is
lost and the same operation is retried.

### 4.3 Authorization

The caller must:

- be an authenticated account with `collection:write`;
- own at least one active Collection for the exact Content;
- have access to the tool under current account entitlement.

An unauthorized or foreign Content is returned as not found so the endpoint
does not disclose another account's private collections.

## 5. Local Agent workflow

1. Send the original URL or platform share text to
   `attention_collect_content` without pre-reading it.
2. Resolve an ambiguous candidate if required.
3. If `enrichment_action` is `reuse_summary`, finish without reading or model
   work.
4. If it is `generate_summary`, use the host Agent's public-network reading or
   browser capability to inspect the source.
5. Generate a grounded summary and tags from the public page.
6. Call `attention_submit_content_enrichment`.
7. Treat `already_enriched` as success and reuse the winning shared summary.
8. If the Agent cannot read the page, keep the collection saved and leave the
   summary pending. Never invent a summary.

The designated WeChat Bridge is allowed public-network access for this flow.
Host-specific implementation may use Codex or Claude Code native public-web
reading, but Shell writes, unrelated MCP servers, credentials, authenticated
browsing, and private local files remain outside the collection workflow.

## 6. Atomic write and concurrency

The server validates the request and performs one conditional transaction:

1. Confirm active ownership of a Collection for the Content.
2. Lock or conditionally update the Content.
3. Write summary, normalized unique tags, `summary_status=ready`, and
   `enrichment_status=complete` only while no ready summary exists and the
   summary is not hidden.
4. If another transaction already won, return `already_enriched` without
   changing the stored summary or tags.

No role priority exists. A normal user's valid first submission remains the
shared summary if a Filter later collects the same Content.

The audit event records the submitting account, Content ID, tool identity,
result, and timestamps, but never logs the summary text, tags, source URL, page
text, or browser state.

## 7. Worker and Hosted AI behavior

For the first release:

- metadata jobs continue to use Fetcher for title and source metadata;
- no summary job is scheduled when Hosted AI is not configured;
- metadata completion preserves the current database summary state instead of
  writing from a stale snapshot;
- missing summaries remain pending for a local Agent;
- no UI copy claims that Hosted AI is available.

Future Hosted AI uses the same internal enrichment validation and conditional
write service as MCP. It may be scheduled after a grace period only when a
provider is explicitly enabled. It loses the same first-writer race if a local
Agent fills the summary first.

## 8. Existing-data repair

Deployment includes a one-time repair for active Content that has no stored
summary:

- legacy `unavailable` caused solely by absent Hosted AI becomes `pending`;
- inconsistent `pending` rows whose summary and metadata jobs are already
  completed remain `pending` and become eligible for local Agent enrichment;
- `ready` and `hidden` summaries are unchanged;
- terminal safety, takedown, or moderation states are unchanged.

Existing jobs are not blindly replayed while Hosted AI is disabled. A user can
ask their Agent to list and enrich missing summaries, including the three
current Xiaohongshu collections.

## 9. UI states

- `ready`: display the shared summary and tags.
- `pending`: display `摘要待补全`; do not use an error treatment.
- `unavailable`: reserve for a genuine terminal inability after all enabled
  enrichment sources have failed.
- `hidden`: do not offer Agent regeneration.

The UI never implies that summary visibility depends on whether the collector
is a normal user or Filter. Only the Collection card's private/public state
changes.

## 10. Error handling

- Invalid summary or tags -> stable validation error; Content stays pending.
- Page unreadable locally -> no submit call; Content stays pending.
- Concurrent winner -> `already_enriched`, treated as success.
- Lost response -> idempotent retry produces success without overwrite.
- Content hidden or ineligible -> stable non-retryable error.
- Lost Collection ownership -> not found.
- Hosted provider absent -> no job and no error transition.

## 11. Verification

Required automated coverage:

1. New Content requests local enrichment.
2. Existing ready Content skips local reading and reuses its summary.
3. Normal-user summary is reused by a later Filter collection.
4. Concurrent submissions produce one immutable winning summary.
5. Idempotent retries do not overwrite.
6. Foreign or inactive Collection cannot enrich a Content.
7. Hidden and ineligible Content cannot be regenerated.
8. Metadata finishing after summary preserves the ready/unavailable terminal
   state and never restores `pending`.
9. Hosted AI disabled leaves missing summaries pending without scheduling a
   summary job.
10. Existing-data repair changes only the intended legacy rows.
11. Codex and Claude Code designated-channel flows both collect first, read
    only when requested, and submit through the same MCP tool.
12. Logs and audit records contain no raw URL, page text, summary, tags, or
    credentials.

## 12. Release boundary

This design does not build Hosted AI, automatic server-to-device dispatch,
summary editing, multiple summary versions, quality voting, or role-based
summary visibility. Those require separate product decisions after the local
Agent-first flow is proven.
