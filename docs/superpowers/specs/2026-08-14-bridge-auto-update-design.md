# Attention Local Bridge Safe Update Design

**Date:** 2026-08-14  
**Status:** Approved for implementation  
**Scope:** The user-owned `attention-channel` Bridge for Codex and Claude Code

## Outcome

After one explicit bootstrap onto the first updater-capable release, a background
Bridge keeps itself on a compatible release without losing local queues, iLink
credentials, or the selected Agent conversation. Updates that would expand the
local permission boundary never install silently.

## Approaches considered

1. **Notification-only updates.** Safest to implement, but users still run a
   manual command and old background services remain pinned to a versioned file.
   This does not satisfy the desired guarantee.
2. **Manifest-driven managed launcher (selected).** A stable local launcher owns
   process restart and rollback; versioned Bridge artifacts remain immutable.
   The running Bridge checks a public manifest and stages only compatible,
   same-permission releases.
3. **Native package managers or a desktop app updater.** Strong on one platform,
   but does not provide a uniform Codex/Claude Code experience across macOS,
   Linux, and Windows.

## Trust and permission boundary

- `https://<attention-origin>/cli/manifest.json` is the update trust root.
- The manifest and artifact must remain on the exact configured origin. Redirects
  to another origin, embedded credentials, fragments, and query parameters fail
  closed.
- HTTPS is mandatory outside loopback development.
- The artifact SHA-256 in the manifest is verified before execution. This catches
  corruption and mismatched deployment, but does not claim to survive a complete
  compromise of the Attention HTTPS origin. Detached release signing is a future
  hardening step, not a claim of this release.
- A canonical permission profile describes the Bridge's local and cloud boundary.
  Its SHA-256 is compiled into the running CLI and published in the manifest.
- Automatic updates require the same permission-profile hash and the same semantic
  major version. A changed hash or major version is reported as
  `consent_required`; the user must explicitly install that release and re-enable
  the background Bridge.
- Update checks use no MCP token and no Runtime OAuth token. Runtime OAuth remains
  optional and is used only to make device status visible in the Web product.

## Published update manifest

Schema version 2 extends the existing CLI manifest with:

```json
{
  "schema_version": 2,
  "artifact_path": "/cli/attention-0.3.5.mjs",
  "node": ">=22.16.0",
  "sha256": "<64 lowercase hex>",
  "version": "0.3.5",
  "minimum_supported_version": "0.3.5",
  "permission_profile_sha256": "<64 lowercase hex>"
}
```

The publishing script derives the hash and manifest from reviewed source and the
built artifact. Staging smoke tests continue to require the public artifact and
manifest to match the reviewed release.

## Managed local layout

All files are user-owned. Secrets stay in the existing `~/.attention/channel`
directory and are never copied into the updater.

```text
~/.local/share/attention/
  launcher.mjs
  versions/attention-<version>.mjs
~/.attention/update/
  state.json
```

The state file is mode `0600`, its directory is `0700`, and writes use a temporary
file plus atomic rename. It contains only versions, local artifact paths, bounded
timestamps, the approved permission hash, and a stable error code.

`channel start --background` performs the one-time bootstrap:

1. copy the reviewed current artifact into `versions/`;
2. install the stable launcher;
3. atomically set the current version in update state;
4. configure LaunchAgent, systemd user service, or Windows scheduled task to run
   the launcher rather than a versioned Bridge file.

## Check, stage, restart, and rollback

The background Bridge checks once after reaching a healthy idle point, then every
24 hours with deterministic installation jitter. Network or validation failure
never stops message processing; it records a bounded local error and retries later.

When a compatible update exists and both durable queues are empty:

1. download to a new temporary file with a size limit and timeout;
2. verify exact same-origin response and SHA-256;
3. execute the candidate's side-effect-free update probe and require exact version
   and permission hash;
4. atomically rename it into `versions/`;
5. record previous/current/pending state atomically;
6. return the dedicated restart exit code to the stable launcher.

The launcher starts the candidate. The candidate marks itself healthy only after
the Agent preflight, Attention account verification, and local iLink readiness
have succeeded. If it exits or misses the startup deadline first, the launcher
atomically restores the previous version and restarts it. Existing durable queues
and iLink state remain untouched throughout.

## Observability and UX

- `attention channel status` shows installed version, latest checked version,
  update state, last check, and a stable error code without printing URLs,
  credentials, messages, or Agent session identifiers.
- The Web device card uses the already-reported `adapter_version` and the public
  manifest version to show `已是最新`, `建议更新`, or `需要手动确认`. It does not
  infer that an update succeeded before a later heartbeat reports the new version.
- No update progress or failure is sent into the user's WeChat conversation.

## Compatibility and first bootstrap

Version 0.3.4 and earlier do not contain an updater, so they cannot discover this
feature by themselves. Those users must run the documented install/background
command once for 0.3.5. From that release onward, same-permission compatible
updates are automatic.

## Failure behavior

- Invalid manifest, cross-origin artifact, bad SHA, failed candidate probe, disk
  error, or unavailable network: keep the current Bridge running.
- Permission or major-version change: do not download or execute; surface
  `consent_required` locally and in the version comparison shown on Web.
- Candidate startup failure or timeout: roll back to the prior version.
- Device or Bridge offline: no update occurs until it is online again.
- Pending inbound/outbound work: defer restart until both queues are empty.

## Non-goals

- Updating Codex, Claude Code, Node.js, the Attention Skill, or MCP credentials.
- Uploading local update state through Runtime Reporter.
- Hosted Agent or Hosted Channel updates.
- Claiming detached artifact signatures before a protected signing key and release
  ceremony exist.

