# @attention/dsh

DeepSeek Harness bundle for Attention. It activates DSH's official
`@deepseek-ai/dsh-mcp-client` against an Attention Streamable HTTP MCP server.

## Configure credentials

Set the MCP endpoint and an Attention API key in the environment inherited by
DSH (for example, in the DSH home `.env` file):

```bash
export ATTENTION_MCP_URL=https://attention.example/mcp
export ATTENTION_API_KEY=att_pat_replace_me
```

`ATTENTION_MCP_URL` defaults to `http://127.0.0.1:3000/mcp` for local
development. DSH's built-in MCP client currently accepts static headers, so
this bundle uses an API key rather than claiming an unsupported OAuth flow.

## Install

Install the plugin into a named DSH profile, verify the composed Cordis config,
and then start the same profile:

```bash
dsh plugin --profile web add @attention/dsh
dsh --profile web --dump-config
dsh --profile web
```

Install `SKILL.md` at `~/.dsh/skills/attention/SKILL.md`. The Attention CLI can
download the validated Skill and add the plugin in one flow:

```bash
attention configure deepseek --origin https://attention.example --apply
```

The MCP tools are exposed by DSH with the `mcp__attention__` prefix. For
example, Attention's `attention_get_my_account` tool appears as
`mcp__attention__attention_get_my_account`.

## Scope

This package provides interactive Skill and MCP integration only. It does not
ship a WeChat/iLink channel adapter or an Attention Runtime reporter.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
```
