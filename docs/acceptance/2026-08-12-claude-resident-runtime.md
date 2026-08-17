# Claude Code Resident Runtime Acceptance — 2026-08-12

## Scope

This record covers the local Attention Channel bridge when its selected host is
Claude Code. It validates the host-neutral capabilities that already exist for
Codex: one resident Agent process, durable multi-turn conversation continuity,
session recovery after a process restart, 20-turn local replay when the stored
session no longer exists, the restricted six-tool Attention MCP profile, and
optional privacy-safe device status sync.

## Accepted implementation

- Claude Code version exercised: `2.1.226`.
- Transport: one long-lived `claude -p` process using stream-json input/output.
- Consecutive user turns reuse the same process and Claude session ID.
- A bridge restart resumes the persisted session ID.
- An explicitly missing session returns `resumeFailed`; the shared Channel
  pipeline then rebuilds context from at most the local latest 20 user/assistant
  turns.
- A process crash is restarted with the latest successful Claude session ID.
- Preflight account verification runs in a disposable session and is never
  persisted as the user's Channel conversation.
- Failed, cancelled, partial, or timed-out results never dequeue an inbound
  message as a successful reply.
- Shutdown rejects active and queued work from the previous lifecycle.

## Restricted capability boundary

The resident Claude process is started with strict MCP configuration, no
built-in tools, and only the following Attention Channel tools:

1. `attention_get_my_account`
2. `attention_list_collections`
3. `attention_collect_content`
4. `attention_select_collection_candidate`
5. `attention_get_collection_status`
6. `attention_update_collection`

Shell, code execution, local file access, browser automation, hooks, plugins,
Skills, and every other MCP are outside the resident Channel profile. Attention
account entitlements and tool-side permission checks still apply.

## Real-process evidence

A real Claude Code process accepted the stream-json protocol and returned a
successful result. A second real-process exercise completed two turns in one
resident session, then resumed that same session in a new process. The observed
properties were:

- resident turns: `2`;
- same session across resident turns: `true`;
- same session after process resume: `true`;
- total measured exercise time: `6790 ms`.

The first sandboxed exercise produced provider network retries because the test
sandbox blocks external network access. Re-running the same bounded protocol
exercise outside that sandbox succeeded; this was an environment restriction,
not a transport failure.

## OAuth and Runtime truth

MCP OAuth remains owned by the selected host, so Codex and Claude Code may render
different host callback tabs. Attention's own authorization form is shared.
Device status sync is a second, optional Runtime OAuth connection and now uses
one host-neutral Attention completion document for received, cancelled, invalid,
and wrong-route callback states.

`attention configure <host> --apply --login` completes Skill, MCP setup, and MCP
OAuth only. After MCP acceptance and WeChat pairing already work, the Skill may
recommend `attention device sync enable`; it waits for explicit user consent and
explains that declining does not affect collection or WeChat.

The Runtime Reporter may upload only device/runtime phase, timestamps, stable
error codes, bounded queue counts, and pairing results. It never uploads iLink
credentials, Agent credentials, session IDs, messages, replies, contacts, or
collected URLs. Ordinary MCP collection is separate and necessarily sends the
URL the user asked Attention to store.

## Claim boundary

Automated transport, lifecycle, restriction, callback, and contract tests pass,
and real Claude session continuity is accepted. This acceptance did not invoke
the staging `attention_get_my_account` tool through the external Claude provider,
because doing so would transmit live account data to that provider. Public
`can_confirm_runtime` and pairing confirmation claims therefore remain `false`
until the user performs the existing account acceptance and service-side live
evidence is recorded.
