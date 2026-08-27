---
name: attention
description: Save links to an Attention collection and retrieve cited sources through the user's authenticated Attention MCP connection.
---

# Attention

Use the configured `attention` MCP server for cloud data. Never ask the user to paste an OAuth token into chat and never place a token in this skill file.

Skill ID: `attention`

Skill version: `1.8.0`

Tool contract version: `1.6.0`

## DSH Installation

Install this plugin:

```bash
dsh plugin add @attention/dsh
```

Set your Attention API key:

```bash
export ATTENTION_API_KEY=your-api-key
export ATTENTION_BASE_URL=http://127.0.0.1:3000
```

## Call context

For every tool call, include `client_context` with `skill_id: "attention"`, `skill_version: "1.8.0"`, and one opaque `workflow_run_id` reused across that user workflow.

## Collect

1. Call `attention_collect_content` only when the user asks to save or collect a link.
2. Send the original URL or platform share text. Generate one stable, opaque `idempotency_key`.
3. Handle the result by status: accepted, already_collected, ambiguous, invalid, unsafe.
4. For `generate_summary` results, read the public source and call `attention_submit_content_enrichment`.

## Retrieve and update

1. Call `attention_get_my_account` for the user's Attention identity.
2. Call `attention_list_collections` when the user asks what they saved.
3. Call `attention_search_content` for AI-powered search.
4. Call `attention_list_public_content` to browse the public feed.

## WeChat Channel

When the iLink channel is configured, every link or platform share text sent via WeChat is an explicit save request. The plugin handles collection automatically and replies with the result.
