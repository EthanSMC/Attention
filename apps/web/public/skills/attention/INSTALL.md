# Install Attention in a user-owned Agent

Status: first-release infrastructure contract
Catalog schema: `2.2.0`

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
| Codex | available in CLI/Desktop | planned local `attention-channel` | Codex SDK companion is contract-only | MCP only |
| Claude Code | available in Code/Desktop surfaces | unshipped local adapter | CLI Channels are experimental and require a running CLI | MCP only |
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
{attention_origin}/skills/attention/bundles/attention-workbuddy-1.3.0.zip
SHA-256: a9151767dc7b06106d0b6dc91024f670ccd76b9adba03d50ac45cc0c7e09fad8
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

A Skill does not create a persistent message listener. The proposed local
`attention-channel` process would own iLink polling and invoke Codex through
the official Codex SDK in an isolated profile. That companion is
`contract_only`: it is not shipped, and an inbound message is not guaranteed
to appear as a visible Desktop conversation.

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

The interactive Attention MCP path requires Claude Code `>= 2.1.186` for the
documented `claude mcp login attention` command. Claude Code Channels
(`>= 2.1.80`) are a separate research-preview CLI feature: a custom stdio
Channel can push messages only while a compatible CLI session is already
running. It is not a supported Desktop wake-up mechanism, and the Attention
iLink Channel adapter has not shipped.

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

The backend exposes a separate Local Channel Runtime resource for future
OpenClaw, Hermes, Codex, and Claude adapters:

```text
Resource: {attention_origin}/api/runtime
Scopes:   runtime:register runtime:heartbeat channel:bind:report channel:disconnect:report
```

The Runtime and MCP clients have separate access tokens, refresh tokens,
audiences, and revocation boundaries. An Attention API Key cannot replace the
Runtime credential. Because no corresponding local reporter is shipped in
this release, manifests label this axis `contract_only` and `claims` remain
false.

## Credential and privacy boundary

- iLink token, context token, sync cursor, contact data, and media keys remain
  local to the Channel Owner.
- Attention receives normal authenticated MCP calls. A future authorized
  reporter may submit installation metadata, opaque fingerprints, pairing
  results, and health timestamps—but never the channel credential.
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
