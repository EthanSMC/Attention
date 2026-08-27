---
name: attention
description: Save links to an Attention collection and retrieve cited sources through the user's authenticated Attention MCP connection.
---

# Attention

Use the configured `attention` MCP server for cloud data. In DSH, its tools are
namespaced as `mcp__attention__<tool-name>`. Never ask the user to paste an API
key into chat and never place a key in this skill file.

Skill ID: `attention`

Skill version: `1.8.0`

Tool contract version: `1.6.0`

## DSH Installation

Install this plugin:

```bash
dsh plugin --profile web add @attention/dsh
```

Set your Attention API key:

```bash
export ATTENTION_API_KEY=att_pat_replace_me
export ATTENTION_MCP_URL=https://attention.example/mcp
```

## Call context

For every tool call, include `client_context` with `skill_id: "attention"`, `skill_version: "1.8.0"`, and one opaque `workflow_run_id` reused across that user workflow.

## Collect

1. Call `mcp__attention__attention_collect_content` only when the user asks to save or collect a link.
2. Send the original URL or platform share text. Generate one stable, opaque `idempotency_key`.
3. Handle the result by status: accepted, already_collected, ambiguous, invalid, unsafe.
4. For `generate_summary` results, read the public source and call `mcp__attention__attention_submit_content_enrichment`.

## Retrieve and update

1. Call `mcp__attention__attention_get_my_account` for the user's Attention identity.
2. Call `mcp__attention__attention_list_collections` when the user asks what they saved.
3. Call `mcp__attention__attention_search_content` for AI-powered search.
4. Call `mcp__attention__attention_list_public_content` to browse the public feed.
