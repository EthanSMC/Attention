---
name: attention
description: Save links to an Attention collection and retrieve cited sources through the user's authenticated Attention MCP connection.
---

# Attention

Use the configured `attention` MCP server for cloud data. Never ask the user to paste an OAuth token into chat and never place a token in this skill file.

## Workflows

1. When the user asks to save a link, call `attention_collect_content`. A Free account can save unlimited private links. Only a Filter may request public visibility.
2. When the user asks what they previously saved, call `attention_list_collections` with a focused query and a small limit. Return the original-source links as citations.
3. Use `attention_search_content` only when it is advertised by the server. It is a Member capability and may disappear if the live membership expires.
4. Treat private collection results as private. Do not mix them into public answers or share them with another account.
5. If a tool reports `membership_required`, explain which operation needs Member; do not retry through a public endpoint to bypass the limit.

Attention stores the URL of cloud-synced private links. It does not store or redistribute the full third-party original solely because a link was collected.
