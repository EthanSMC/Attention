# Install Attention in a user-owned Agent

Status: first-release infrastructure contract
Catalog schema: `2.3.0`

Attention does **not** provide a Hosted Agent or a Hosted Channel UI in this
release. The Agent and every WeChat/iLink credential remain on the user's
device. The public manifest describes what is available now, what belongs to
an external host, what is experimental, and what is only a future contract.

Machine-readable catalog:

```text
/skills/attention/installations/v1/index.json
```

`v1` in this URL means the first product-release catalog. The JSON shape is
independently versioned by `schema_version`.

## Capability axes

Do not infer one capability from another. Each host manifest has six separate
axes:

1. `interactive`: can a person use the Attention Skill and MCP now?
2. `channel`: who owns local WeChat setup, and is its state observable?
3. `runtime_reporting`: has an Attention Runtime reporter actually shipped?
4. `inbound`: what can wake or invoke the Agent from a local message?
5. `desktop`: what works interactively in Desktop, on which operating systems,
   separately from inbound?
6. `claims`: what Attention itself can confirm without trusting UI copy?

Availability values are deliberately precise:

- `available`: shipped and directly usable.
- `available_external`: usable through a separately installed host/plugin.
- `experimental`: a host research-preview surface with stated limitations.
- `contract_only`: protocol or design exists, but the required adapter is not
  shipped.
- `host_managed_unverifiable`: the host may work, but exposes no supported
  status/event interface to Attention.
- `unsupported`: no supported path.

All five hosts can use the same Streamable HTTP MCP business interface:

```text
Skill: {attention_origin}/skills/attention/SKILL.md
MCP:   {attention_origin}/mcp
Auth:  OAuth in the user's browser
```

An authenticated MCP connection proves only that the Agent can call Attention
for that account. It does not prove that WeChat is connected.

## Safe command templates

Commands in the JSON manifests are encoded as `{ "executable", "args" }`,
not shell strings. Installers must substitute only the declared placeholders
and launch with `shell: false`:

- `{attention_origin}`: HTTPS Attention origin, without a trailing slash.
- `{mcp_url}`: `{attention_origin}/mcp`.
- `{skill_url}`: `{attention_origin}/skills/attention/SKILL.md`.
- `{skill_bundle_url}`: a published host-importable bundle, when one exists.
- `{attention_skill_directory}`: a verified local Skill directory.

Never put an OAuth token, API Key, or channel credential in one of these
placeholders.

## Host matrix

| Host | Interactive Skill/MCP | WeChat owner | Inbound reality | What Attention can confirm |
|---|---|---|---|---|
| OpenClaw | available | external Tencent `openclaw-weixin` plugin | host-native, OpenClaw `>= 2026.5.12` for the current plugin | MCP only; Runtime reporter is contract-only |
| Hermes Agent | available | native Hermes Gateway | host-native gateway | MCP only; Runtime reporter is contract-only |
| Codex | available in CLI/Desktop | local `attention-channel` bridge shipped with the Attention CLI | the published bridge polls iLink and invokes one resident Codex app-server in a restricted profile | MCP plus optional privacy-safe Runtime health/checkpoints; real-device pairing remains unconfirmed until device acceptance |
| Claude Code | available in Code/Desktop surfaces | local `attention-channel` bridge shipped with the Attention CLI | the bridge polls iLink and invokes headless Claude Code in a restricted profile | MCP only; the bridge does not report to the Runtime in this release |
| WorkBuddy | Skill bundle and MCP available in `>= 4.8.2` | WorkBuddy UI | host-managed | MCP only; channel state is unverifiable |

No manifest claims that Attention knows a user's real WeChat identity. The
service stores no iLink token, contact list, media key, or provider account ID.

## OpenClaw

OpenClaw does not install a Skill from a lone hosted `SKILL.md` URL. Download
the public file and save it as one of these staging files. The Web connection
page generates a copyable macOS/Linux command and a Windows PowerShell command
that download the file as data, verify the manifest's exact SHA-256, and only
then atomically move it into place. Neither command executes remote content:

```text
macOS / Linux: ./attention-skill/SKILL.md
Windows:       .\attention-skill\SKILL.md
```

Then use the argv template published in `openclaw.json` (use the matching
directory separator on Windows):

```text
openclaw skills install {attention_skill_directory} --as attention
```

Configure and authorize MCP with the manifest's `mcp` commands. WeChat is an
external Tencent plugin, not an Attention component. The current unversioned
package requires OpenClaw `>= 2026.5.12` and Node.js `>= 22.16.0`. Check both
local versions before changing configuration:

```text
node --version
openclaw --version
```

Then install and activate the plugin in this order:

```text
openclaw plugins install @tencent-weixin/openclaw-weixin@2.4.6
openclaw config set plugins.entries.openclaw-weixin.enabled true
openclaw channels login --channel openclaw-weixin
openclaw gateway restart
openclaw channels status --probe
```

The host probe is local evidence for the user. Until an Attention Runtime
reporter/plugin is shipped and authorized, the Attention service cannot turn
that probe into a verified “WeChat connected” state.

## Hermes Agent

Hermes supports installing the public Skill URL directly:

```text
hermes skills install {skill_url}
```

`hermes mcp add ... --auth oauth` is interactive: the command itself opens
OAuth and then asks which tools to enable. Run it in an interactive terminal.
Do not launch it from an installer with stdin disabled, and do not run a
second `mcp login` during initial setup. `hermes mcp login attention` remains
the explicit re-authentication command; `hermes mcp test attention` is the
probe. Weixin is configured through the native Gateway:

```text
hermes gateway setup
hermes gateway status
```

Hermes Desktop can share interactive configuration and Skills, but the
Gateway remains the inbound owner. Attention Runtime reporting still requires
a separate helper that has not shipped.

## WorkBuddy

WorkBuddy `>= 4.8.2` supports standard MCP OAuth. It also supports a local
WeChat assistant and uploading a local Skill bundle through its UI. Attention
publishes the uploadable bundle at:

```text
{attention_origin}/skills/attention/bundles/attention-workbuddy-1.4.0.zip
SHA-256: fdc294e8e5f4921629db2b64cc7f79fd39aa5e4f82db1836344da90088055b01
```

The archive contains `SKILL.md` directly at its root, as required by Tencent's
published Skills ZIP specification. Download it, verify the digest, then use
WorkBuddy's **Add Skill → Upload Skill** UI. The Web connection page presents
this as a numbered checklist: download ZIP, verify SHA-256, upload through the
host UI, then add the MCP address and finish OAuth. It does not claim to import
or enable the Skill automatically.

Official references:

- WorkBuddy local Skill upload:
  <https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Skills-Market>
- WorkBuddy MCP configuration:
  <https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/MCP-Guide>
- Tencent Skills ZIP layout (`SKILL.md` at archive root):
  <https://cloud.tencent.com/document/product/1759/134602>

WorkBuddy exposes no supported channel-binding status API, lifecycle event,
heartbeat, or WeChat identity export to Attention. There is therefore no
Runtime OAuth client, no MCP-event workaround, and no Attention-side “WeChat
connected” claim for WorkBuddy. The WorkBuddy UI is the only channel-status
surface in this release.

## Install the Attention CLI

Codex and Claude Code use the local Attention CLI for verified setup and the
WeChat/iLink bridge. The CLI is published as a single executable ESM bundle on
the same HTTPS origin as this document. The current version, required Node.js
version, artifact path, and SHA-256 digest are machine-readable at:

```text
{attention_origin}/cli/manifest.json
```

An Agent installing it must perform these steps in order:

1. Confirm the installed Node.js version satisfies the manifest's `node`
   requirement (`>= 22.16.0` for the first release).
2. Download the manifest and the exact `artifact_path` over HTTPS into
   temporary files. Do not pipe downloaded bytes into a shell or interpreter.
3. Compute SHA-256 locally and compare it with `manifest.sha256`. Abort without
   replacing an existing installation if it differs.
4. Install the verified `.mjs` under a user-owned data directory and create a
   user-owned `attention` launcher that invokes it with Node.js.
5. Run `attention --help`, then continue with the selected host's configure,
   OAuth, acceptance, and WeChat steps below.

For macOS / Linux, use `shasum -a 256` or `sha256sum` and install the launcher
under `~/.local/bin` (or another existing user-owned PATH directory). For
Windows PowerShell, use `Get-FileHash -Algorithm SHA256`, keep the `.mjs` under
`$env:LOCALAPPDATA\Attention`, and create an `attention.cmd` launcher in a
user-owned PATH directory. Never request administrator access merely to install
Attention, and never overwrite a verified working version before the new
artifact passes SHA-256 validation.

## Codex CLI and Desktop

Codex CLI and Desktop can use the same local Skill/MCP configuration. The
manifest publishes real `codex mcp add`, `codex mcp login`, and
`codex mcp get` argv templates for that interactive path.

The Web connection page publishes source-free macOS/Linux and Windows
PowerShell commands that download, verify, and atomically install the
standalone Skill at the documented Codex user scope. A browser download is not
an installation until `SKILL.md` is saved at the matching path:

```text
macOS / Linux: ~/.agents/skills/attention/SKILL.md
Windows:       %USERPROFILE%\.agents\skills\attention\SKILL.md
```

Codex Desktop is available on macOS and Windows; this Desktop platform list
is separate from the broader Codex CLI platform list.

A Skill does not create a persistent message listener. WeChat inbound is
provided by the local `attention-channel` bridge shipped with the Attention
CLI:

```text
attention channel start codex --origin {attention_origin} --background
```

The bridge runs on the user's machine, owns iLink polling after a one-time
QR scan, and keeps one `codex app-server` process resident in a restricted
profile that allows only the Attention MCP. It is a local process, not an
Attention-hosted service:
`--background` installs a current-user service after the explicit first QR
scan, so closing the terminal does not stop inbound delivery. An inbound
message is not guaranteed to appear as a visible Desktop conversation. A future Codex SDK
companion remains a separate `contract_only` design alternative.

Attention CLI `0.2.1` keeps the same local bridge as the sole iLink owner and
keeps one `codex app-server` resident. It first resumes the locally
persisted thread ID; if that thread cannot be resumed, it creates a thread after
replaying the local last 20 user/assistant exchanges. Its Channel defaults are
`gpt-5.6-luna`, reasoning effort `medium`, and verbosity `low` for every user.
It uses a dedicated Channel `CODEX_HOME` and fails closed unless app-server
reports exactly one MCP server named `attention`. Its optional Runtime Reporter
never sends an iLink credential, Codex token, thread ID, message, URL, or reply
to Attention. Normal authenticated MCP collection does send the URL and
collection metadata that the user explicitly asks Attention to save.
Within that one MCP, the resident Channel may perform the account-scoped
collection writes the user authorized, including collecting a link, selecting
a candidate, and updating a collection. Attention still enforces the account's
entitlements and visibility rules. This does not grant Shell, local filesystem
write, browser automation, code execution, or access to another MCP server.

The published CLI manifest and its SHA-256 digest remain the source of truth
for the exact artifact users install. Run `attention doctor codex` after
installation; it fails with an upgrade instruction when the installed Codex
does not expose the required `app-server` command.

The restricted profile template is published at:

```text
/skills/attention/installations/v1/templates/restricted-profile.json
```

It allows only the Attention MCP and denies shell, code execution, filesystem
write, browser automation, and arbitrary MCP access. It also avoids inheriting
the user's normal working directory or session history.

## Claude Code and Claude Desktop Code tab

Claude Desktop's **Code tab** and Claude Code CLI use the same engine and
share `~/.claude.json` / `.mcp.json`, Skills, hooks, and settings in local
sessions. The ordinary Claude Desktop Chat MCP configuration in
`claude_desktop_config.json` is separate and must not be described as the same
connection. The Code tab is available on macOS, Windows, and Linux beta.

The restricted bridge path requires Claude Code `>= 2.1.226` for the
documented OAuth command plus `--safe-mode` and strict per-invocation MCP
configuration. WeChat inbound is provided
by the local `attention-channel` bridge shipped with the Attention CLI:

```text
attention channel start claude-code --origin {attention_origin} --background
```

The bridge owns iLink polling after a one-time QR scan and invokes headless
Claude Code (`claude -p`) in a restricted tool set that allows only the
Attention MCP. Claude Code Channels (`>= 2.1.80`) remain a separate
research-preview host feature: a custom stdio Channel can push messages only
while a compatible CLI session is already running, and it is not a supported
Desktop wake-up mechanism.

Save the downloaded Skill at Claude Code's personal Skill scope:

```text
macOS / Linux: ~/.claude/skills/attention/SKILL.md
Windows:       %USERPROFILE%\.claude\skills\attention\SKILL.md
```

The Web connection page generates the corresponding source-free
macOS/Linux and Windows PowerShell commands. Both commands validate the exact
manifest SHA-256 before replacing an existing file, and neither executes the
downloaded bytes.

An always-on Claude Agent SDK companion is a separate stable design option,
but third-party use requires the user's own Anthropic API credential (or an
approved cloud provider credential). It cannot reuse claude.ai Pro/Max OAuth
or credits. This alternative remains `contract_only`.

## WeChat inbound via the Attention channel bridge

For Codex and Claude Code, the `attention-channel` bridge is the supported
path from WeChat into the user's own Agent. The bridge ships inside the
Attention CLI and never runs on Attention servers.

Prerequisites:

- A phone with WeChat iOS `>= 8.0.70` or Android `>= 8.0.69` and the
  ClawBot (龙虾) plugin enabled.
- A completed interactive installation: `attention configure <host> --apply
  --login` (Skill installed, MCP configured, OAuth authorized).
- The host CLI (`codex` or `claude`) reachable on PATH.

Start:

```text
attention channel start <host> --origin {attention_origin} --background
```

The first run renders a QR code. Scan it with the phone that has ClawBot
enabled; the login state is stored locally so later runs do not need a new
scan. Once the login is persisted, `--background` installs a current-user
LaunchAgent, systemd user unit, or Windows logon task. It never installs a
root service. The bridge then listens only for the account that scanned the code.
Sending a link or platform share text into that WeChat conversation is an
explicit save request: the bridge invokes the host Agent in a restricted
profile, the Agent calls `attention_collect_content`, and the reply appears
in the same conversation. Multi-turn exchanges (candidate selection,
questions about saved items) continue in the same host session.
`attention channel status` prints local facts only; `attention channel
logout` stops/removes the background service and deletes the local iLink
state. If iLink expires, the service exits without opening an unattended QR
prompt; rerun the same `--background` command in a terminal.

In Attention CLI `0.2.1`, a Codex process failure does not transfer iLink
ownership: the bridge keeps polling, queues normal messages, and can answer
exact local status/help/retry/continue commands. If the whole device or bridge
is offline, WeChat receives no Attention reply. When the optional Runtime
reporter is authorized, Web can show only the last reported heartbeat and
checkpoint; it never takes over iLink or Codex.

Privacy boundary for the bridge:

- The iLink token, sync cursor, and context tokens stay in
  `~/.attention/channel/` on the user's device with restrictive permissions;
  they are never uploaded to Attention.
- The iLink bot identifier is not an Attention identity and is never used
  for login, entitlements, or global identity.
- Bridge logs omit tokens and full message bodies.
- CLI `0.2.1` can optionally authorize a separate Runtime OAuth client. Its
  reporter sends privacy-safe runtime status, timestamps, bounded queue counts,
  checkpoints, and device-pairing results only.
- The reporter never sends iLink credentials, Codex credentials or thread IDs,
  message identifiers or content, URLs, replies, contacts, or raw WeChat
  identifiers.
- This exclusion applies to the Runtime reporter, not to normal authenticated
  Attention MCP operations. When a user asks to save something,
  `attention_collect_content` necessarily sends the saved URL and associated
  collection metadata to Attention so the item can be synchronized and
  processed.
- If the device or bridge is offline, the reporter is offline too: WeChat gets
  no reply, and Web retains only the last heartbeat and checkpoint it received.

## Final acceptance

For every host, configuration output such as `mcp get`, `doctor`, or a local
settings screen is diagnostic evidence only. It does not prove that OAuth and
tool execution work end to end. In the configured Agent, invoke:

```text
attention_get_my_account
```

Only a successful tool result containing the current Attention account counts
as a usable installation. The same requirement is machine-readable as each
host manifest's `acceptance` object.

## Runtime OAuth boundary

The backend exposes a separate Local Channel Runtime resource. Attention CLI
`0.2.1` may authorize it for privacy-safe runtime reporting and device-pairing
results:

```text
Resource: {attention_origin}/api/runtime
Scopes:   runtime:register runtime:heartbeat channel:bind:report channel:disconnect:report
```

The Runtime and MCP clients have separate access tokens, refresh tokens,
audiences, and revocation boundaries. An Attention API Key cannot replace the
Runtime credential. Runtime OAuth is optional: declining it does not prevent
the local bridge or MCP from working, but Attention Web cannot receive live
runtime or pairing updates from that device.

Runtime reporting is not remote channel hosting. Attention receives only
privacy-safe state such as health, timestamps, bounded queue counts,
checkpoints, and pairing outcomes. The iLink credential and Codex thread stay
local; messages, URLs, replies, and raw provider identifiers are never part of
the reporter payload. A normal authenticated MCP save is a separate business
operation and necessarily sends its saved URL and collection metadata to
Attention. When the device or bridge is offline, WeChat cannot
receive a reply and Web can show only the last heartbeat and checkpoint.

## Credential and privacy boundary

- iLink token, context token, sync cursor, contact data, and media keys remain
  local to the Channel Owner.
- Attention receives normal authenticated MCP calls. The optional CLI `0.2.1`
  Runtime reporter may submit installation metadata, opaque fingerprints,
  pairing results, health timestamps, bounded queue counts, and checkpoints—but
  never the channel credential, Codex thread, message, URL, or reply. Normal MCP
  collection is outside that reporter boundary and sends the URL and collection
  metadata that the user explicitly asked Attention to save.
- The Skill is a workflow contract. It is not a listener, a background
  service, a login identity, or proof that Tencent verified the user's real
  identity.
- Disconnecting Attention authorization does not prove that a local token was
  deleted; the local owner must confirm token deletion separately.

## Schema 2.0 migration

Schema `1.0.0` combined Skill/MCP, channel ownership, Runtime status, inbound
activation, and Desktop behavior. It also used `mcp_event` for WorkBuddy and
could be read as claiming unshipped Codex/Claude companions.

For schema `2.0.0` consumers:

- Read `interactive`, `channel`, `runtime_reporting`, `inbound`, `desktop`,
  and `claims` independently.
- Replace `status.control_plane_auth` with `runtime_reporting.mode`.
- Replace `status.heartbeat` with `runtime_reporting.heartbeat`.
- Replace `desktop.supported` with explicit `desktop.interactive`,
  `desktop.inbound`, and `desktop.platforms` values.
- Replace shell command strings with `{ executable, args }` and execute with
  `shell: false`.
- Treat `contract_only`, `experimental`, and
  `host_managed_unverifiable` as non-confirming states.
- Do not synthesize WorkBuddy events or Runtime credentials.

The stable installer fields `id`, `display_name`, `mcp.url_template`, and
`skill.source_path` remain available for schema `1.0.0` consumers migrating
incrementally.

## Schema 2.1 migration

Schema `2.1.0` turns the WorkBuddy Skill from an unpublished contract into a
real, checksum-pinned upload bundle. Consumers moving from `2.0.0` should:

- accept `skill.delivery: "host_upload_bundle"`;
- read `skill.bundle_path`, `skill.bundle_sha256`, and
  `skill.bundle_skill_path`;
- download the bundle only on explicit apply/consent;
- verify SHA-256 before saving it;
- present WorkBuddy import as a manual host UI step, not as an automatic or
  remotely observable installation.

## Schema 2.2 migration

Schema `2.2.0` makes the end-user setup path executable instead of treating a
public URL as proof of installation. Consumers moving from `2.1.0` should:

- read `skill.local_path` and distinguish an `install_target` from a
  `staging_source`;
- for `compatibility.policy: "verify_at_install"`, execute every declared
  non-destructive `compatibility.command_checks` argv template before claiming
  the host is compatible;
- save `SKILL.md` at the platform-specific path before claiming the Skill is
  installed;
- derive the download URL, target path, and SHA-256 from the same host
  manifest; never pipe the downloaded document into a shell or interpreter;
- read `mcp.setup_mode` before executing commands;
- read `mcp.probe_evidence`; `config_only` confirms saved configuration but
  does not prove network, OAuth, or tool availability;
- run `noninteractive_then_login` add/login/probe commands separately;
- keep `interactive_oauth` commands attached to a real terminal with stdin,
  because the add step may perform OAuth and tool selection itself;
- present `host_ui` setup as a manual WorkBuddy action;
- require a successful `acceptance.tool_name` result before claiming the
  installation is usable; configuration-only probes are not acceptance; and
- treat `install_steps[].executor: "user"` as an explicit boundary, not an
  automation failure.

## Schema 2.3 migration

Schema `2.3.0` ships the local `attention-channel` bridge for Codex and
Claude Code. Consumers moving from `2.2.0` should:

- read `inbound.engine: "attention_channel_bridge"` as a shipped local
  bridge that the Attention CLI starts with
  `attention channel start <host> --background`; it is no longer a future contract for
  these two hosts;
- read the bridge activation command from
  `channel.setup_command_templates`;
- read Codex `runtime_reporting.availability: "available"` as the shipped,
  optional privacy-safe Reporter implementation. Keep
  `claims.can_confirm_channel_pairing` and `claims.can_confirm_runtime` false:
  implementation availability is not evidence that a real device completed
  pairing or produced an accepted heartbeat;
- note that the bridge restricted profile still denies shell, code
  execution, filesystem write, browser automation, and arbitrary MCP, and
  does not inherit the user's normal working directory or session history;
- keep treating `codex_sdk_companion` and `claude_channel_preview` as
  valid engine values for future or host-managed alternatives; and
- read Skill `1.4.0` "Designated collection channels" for the conversation
  semantics the bridge declares (tool contract version remains `1.3.0`).
