# Attention CLI

第一期范围以 [`docs/first-release-scope.md`](../../docs/first-release-scope.md) 为准。本 CLI 只配置用户自己的 Agent 与 Attention 基础设施，不启动 Attention Hosted Agent 或 Hosted Channel。

`@attention/cli` configures the public Attention Skill and hosted MCP endpoint
for user-owned Agents. It also performs read-only diagnostics without reading
or printing OAuth tokens.

This is an infrastructure installer, **not** a hosted Agent. It configures the
Attention side of a user-owned Agent; any iLink credential and local channel
process remain on the user's device. In this release:

- OpenClaw and Hermes own their local WeChat gateways through host plugins.
- WorkBuddy owns its WeChat assistant and provides no public binding-status API
  to Attention.
- Codex and Claude Code receive WeChat messages through the local
  `attention-channel` bridge shipped with this CLI (`attention channel start
  <host>`). The bridge polls the official iLink API after a one-time QR scan
  and invokes the host Agent in a restricted Attention-only profile. The
  bridge runs on the user's machine, never uploads the iLink credential, and
  does not report channel state to Attention in this release.

Attention never asks for, uploads, or prints a local iLink credential.

## Build

```bash
pnpm --filter @attention/cli build
node apps/cli/dist/index.js --help
```

When packaged, `apps/cli/dist/index.js` is exposed as the `attention` binary.

## List integrations

```bash
attention integrations list
attention integrations list --json
```

The list is generated from `@attention/contracts` rather than a separate CLI
capability table.

## Configure an Agent

Configuration is a dry run by default:

```bash
attention configure codex \
  --origin https://attention.example.com
```

It prints the Skill source, exact MCP add/login/probe commands, official host
documentation, and the truthful local-channel boundary.

To stage the Skill and execute only manifest-declared Skill/MCP setup commands:

```bash
attention configure codex \
  --origin https://attention.example.com \
  --apply
```

OAuth is never opened implicitly. Start it only with explicit consent:

```bash
attention configure codex \
  --origin https://attention.example.com \
  --apply --login
```

For hosts with a real filesystem Skill root, `--apply` installs the validated
`SKILL.md` directly to the host's user scope:

- Codex: `~/.agents/skills/attention/SKILL.md`
- Claude Code: `~/.claude/skills/attention/SKILL.md`

OpenClaw `>= 2026.5.12` first stages the source under
`./attention-skill/SKILL.md`, then passes that directory to its host install
command. Override the selected directory with `--skill-dir`. Existing content
is not replaced unless its bytes already match; use `--force-skill` together
with `--apply` to replace a changed copy.

WorkBuddy `>= 4.8.2` remains a UI handoff for Skill import, MCP, and OAuth.
Attention publishes a checksum-pinned WorkBuddy ZIP with `SKILL.md` at the
archive root. `attention configure workbuddy --apply` downloads and verifies
that bundle to `~/Downloads` by default; use `--skill-dir` to select another
safe download directory. The CLI does **not** import or enable the ZIP—it tells
the user to upload it in WorkBuddy's Skill UI. It also will not report “WeChat
connected,” because no official status interface exists for that claim.

Hermes MCP setup is interactive: `hermes mcp add ... --auth oauth` opens the
browser and then asks which tools to enable. The Attention CLI prints that
command but never runs it with detached stdin; the user completes it in their
own terminal.

## WeChat inbound (channel bridge)

For Codex and Claude Code, the bridge turns the WeChat ClawBot conversation
into a designated Attention collection channel. Prerequisites: a completed
`attention configure <host> --apply --login` and a phone with WeChat
iOS `>= 8.0.70` or Android `>= 8.0.69` plus the ClawBot plugin.

```bash
attention channel start codex --origin https://attention.example.com --background
# or: attention channel start claude-code --origin https://attention.example.com --background
```

The first run renders a QR code; scan it once. After account and iLink
acceptance, `--background` installs a user-owned LaunchAgent, systemd user
unit, or Windows logon task—never a root service. Sending a link or platform
share text into the WeChat conversation then invokes the host Agent with only
the Attention MCP available, collects the content, and replies in the same
conversation. Follow-up turns continue in the same host session. If the local
iLink login expires, rerun the same command in a terminal so QR login remains
an explicit user action.

```bash
attention channel status [--json]   # local facts only, never credentials
attention channel logout            # stop background bridge and delete iLink state
```

State lives under `~/.attention/channel/` with restrictive permissions. The
bridge does not register with the Local Channel Runtime, so the Attention
service and Web cannot observe bridge state. `status` reports privacy-safe
facts from this device only.

## Diagnose

```bash
attention doctor codex \
  --origin https://attention.example.com

attention doctor codex \
  --origin https://attention.example.com \
  --probe
```

Doctor checks:

1. installed host version (or identifies a UI-only host);
2. manifest-declared non-destructive command capability checks when no minimum
   host version is pinned;
3. unauthenticated MCP OAuth challenge;
4. protected-resource metadata, audience binding, and every scope required by
   the current Attention MCP installation contract;
5. availability of the host OAuth-login command without executing login;
6. with `--probe`, any host-supported OAuth-session status (including Codex
   `auth_status` and Claude Code's connection health);
7. the declared probe evidence level: saved configuration is not accepted as
   live evidence, health checks do not claim `tools/list`, and a `live_tools`
   probe must enumerate every tool in the current Attention contract;
8. for bridge hosts, whether a local attention-channel login state exists on
   this device (never the credential itself, never a server-side status).

`--probe` exits non-zero when a host can only prove saved configuration. This
is intentional: installing an MCP URL is not evidence that OAuth completed or
that the current tool contract is callable.

Subprocesses are launched with argument arrays and `shell: false`. Diagnostic
output is bounded and common token/key forms are redacted. Use `--json` for CI
or setup UIs.

## Development origin

Set `ATTENTION_ORIGIN` instead of repeating `--origin`:

```bash
ATTENTION_ORIGIN=http://127.0.0.1:3300 \
  attention doctor codex
```

Plain HTTP is accepted only for loopback development; other origins must use
HTTPS and may not include credentials, query parameters, or fragments.
