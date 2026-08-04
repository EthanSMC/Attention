---
name: attention
description: Save links to an Attention collection and retrieve cited sources through the user's authenticated Attention MCP connection.
---

# Attention

Use the configured `attention` MCP server for cloud data. Never ask the user to paste an OAuth token into chat and never place a token in this skill file.

Skill ID: `attention`

Skill version: `1.0.0`

Tool contract version: `1.0.0`

## Call context

For every tool call, include `client_context` with `skill_id: "attention"`, `skill_version: "1.0.0"`, and one opaque `workflow_run_id` reused across that user workflow. Use only letters, numbers, `.`, `_`, `:`, or `-`; never put user text, a URL, a query, or a credential in these fields.

## Collect

1. Call `attention_collect_content` only when the user asks to save or collect a link. Do not infer a save request merely because a link appears in a question.
2. Send the original URL or platform share text. Generate one stable, opaque `idempotency_key` for the user's save request and reuse it for every retry of that request.
3. Handle the result by status:
   - For `accepted`, `already_collected`, or `merged_with_existing_content`, keep the returned IDs and call `attention_get_collection_status` when processing state matters.
   - For `ambiguous`, show the candidates and ask the user to choose. Then call `attention_select_collection_candidate` with the returned candidate ID and one-time selection token. Never guess a candidate.
   - For a pending or retryable result, respect `retry_after_seconds`, check with `attention_get_collection_status`, and make at most two automatic retries for the same operation. Reuse the original idempotency key.
   - For `invalid` or `unsafe`, explain the stable error and stop. Do not rewrite the URL to bypass safety checks.
4. If your own Browser, Computer Use, or Web Search cannot read the page, still call `attention_collect_content` with the original URL. A reading or extraction failure must not make the link disappear.

## Retrieve and update

1. Call `attention_list_collections` with a focused query and small page size when the user asks what they saved. Follow pagination only as needed and return original-source links as citations.
2. Call `attention_search_content` only when the server advertises it. Search is a live Member capability and can disappear when membership expires.
3. Call `attention_list_public_content` for the public feed. Respect `preview_limited`; do not use another endpoint to expand a Free preview.
4. Call `attention_get_collection_status` for a known attempt or collection instead of repeatedly listing collections to guess whether processing finished.
5. Call `attention_update_collection` to change public/private visibility. Only an active Filter may make a collection public; the server rechecks that status on every call.

## Boundaries

- Use the Agent's own Browser, Computer Use, or Web Search to understand a public page. Do not ask Attention for a general browser or attempt to discover a private runtime web tool.
- Do not submit copied page text, extracted full content, cookies, authorization headers, or browser state as collection evidence. Third-party extraction is not trusted Attention acquisition evidence.
- Treat private collection results as private. Do not mix them into public answers or share them with another account.
- If a tool returns `insufficient_scope`, `membership_required`, or `filter_required`, explain the required permission or entitlement. Do not retry through a public or anonymous endpoint to bypass it.
- Never place an OAuth token or PAT in tool input, citations, logs, or this skill. Attention stores collected URLs and necessary metadata, not a third-party original merely because its link was collected.
