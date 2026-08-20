# Channel Session Takeover Design

**Date:** 2026-08-20  
**Status:** Approved for implementation  
**Scope:** Local WeChat Channel Runtime binding ownership, CLI release `0.3.8`, and public CLI artifact retention

## Problem

`POST /api/runtime/channel-bindings` currently relies on a global unique index over
`(provider, channel_account_fingerprint)`. A verified binding owned by an older Runtime
installation therefore makes a newly authorized Bridge fail with
`409 channel_owner_conflict`. The new installation cannot see or disconnect the old row
through account-scoped RLS, so the Reporter degrades permanently and `/agent` shows the
Bridge as unconfigured.

The desired ownership rule is explicit: the Bridge using the newest WeChat QR-login
session replaces every older binding for that WeChat account, even when the old Bridge is
currently healthy or belongs to another Attention account.

## Security Model

QR login returns an iLink `bot_token`. The token remains local and is never uploaded.
CLI `0.3.8` derives two independent opaque values:

- the existing channel account fingerprint from the iLink account ID;
- a new channel session fingerprint from the iLink `bot_token`, using a distinct domain
  separator and SHA-256.

The session fingerprint identifies one QR-login session without exposing the token. A
session fingerprint retained on a replaced binding is a tombstone: that older session may
not claim the channel again. This prevents an online old Bridge from winning the binding
back through retries.

The server continues to require an authenticated Runtime OAuth principal with
`channel:bind:report` and a registered installation. API responses never disclose the old
account, installation, binding, token, or session fingerprint.

## Contract and Storage

`CreateChannelBindingRequestSchema` gains an optional
`channel_session_fingerprint`. It is optional on the wire for rolling compatibility with
CLI `0.3.7`, but CLI `0.3.8` always sends it.

`external_channel_bindings` gains a nullable `channel_session_fingerprint char(64)` with a
hex-format check and an index supporting lookup by provider, channel fingerprint, and
session fingerprint. Existing rows remain `NULL`; no credential backfill is possible or
required. The field is internal and is not added to `ChannelBindingView`.

The event ledger accepts `channel.binding.replaced.v1`. Its metadata identifies only the
new installation, new binding, provider, and the fact that a prior active binding was
replaced.

## Atomic Replacement

Channel creation runs under the existing principal transaction and takes a transaction-
scoped advisory lock derived from the provider and channel account fingerprint.

A narrowly scoped `SECURITY DEFINER` database function performs the cross-account part
that ordinary RLS correctly prevents. The function:

1. verifies that the requested new account matches `app.account_id` and that the new
   installation belongs to that account;
2. rejects a session fingerprint that already appears on a different historical binding
   with `channel_session_superseded`;
3. revokes every unconsumed challenge attached to active conflicting bindings;
4. marks every active conflicting binding `revoked`;
5. returns only whether a replacement occurred.

The function uses a fixed `search_path`, exposes no row data, is not executable by
`PUBLIC`, and is granted only to `attention_web_runtime`. The application then creates the
new account-owned `reported` binding and its pairing challenge through normal RLS in the
same transaction.

If the same installation and same session already owns a `reported` binding, the existing
row is reused and its pairing challenge is renewed. If it owns a verified/healthy/stale
binding but local state lost the binding ID, the service resets that same row to
`reported`, clears verification-only fields, and issues a fresh challenge instead of
creating a duplicate.

Among concurrent previously unseen sessions, advisory locking makes replacement serial;
the last successful creation wins. Once replaced, an older session is permanently
ineligible to reclaim the channel.

## Legacy Clients and Errors

- A `0.3.7` Bridge with an existing binding can continue heartbeat and activity reporting.
- A legacy request without a session fingerprint may create the first-ever binding for a
  channel.
- A legacy request that encounters binding history is rejected with
  `channel_session_proof_required`; it must update before taking ownership.
- A previously replaced session receives `channel_session_superseded`.
- Other authentication, installation, provider, and request validation behavior remains
  unchanged.

CLI logging maps the two new stable errors to actionable, non-secret messages. It does not
loop creating new installation IDs for a superseded WeChat session.

## User Flow

After upgrading to CLI `0.3.8`, the current Bridge computes its session fingerprint and
retries registration. The server atomically revokes the old binding and returns a fresh
pairing challenge. The user replies with the pairing code in WeChat ClawBot. Successful
verification changes the new binding to verified/healthy, after which `/agent` reports the
Bridge and WeChat path as connected.

Replacement changes server ownership but does not remotely terminate an old local
process. The design relies on WeChat's QR-login session rotation to invalidate the older
iLink session; the server-side tombstone independently prevents that session from
reclaiming Runtime ownership.

## Public CLI Artifact Retention

The public release directory will retain only the manifest and the currently published
bundle. During this change:

- generate `apps/web/public/cli/attention-0.3.8.mjs`;
- update `manifest.json` and installation documentation to `0.3.8`;
- delete tracked bundles `attention-0.1.0.mjs` through
  `attention-0.3.7.mjs`.

The deleted files remain recoverable from Git history. Local installed Bridge files and
`~/.attention` credentials are outside this cleanup and must not be removed.

## Testing

Implementation follows red-green-refactor and covers:

- the contract accepts and validates the optional session fingerprint without exposing it
  in views;
- CLI derives different account and session fingerprints and never serializes the token;
- an unseen session replaces reported, verified, healthy, and stale bindings across
  installations and accounts;
- replacement revokes old challenges and emits a privacy-safe audit event;
- the replaced session cannot reclaim the channel;
- concurrent replacement is serialized and ends with one active owner;
- RLS cannot be bypassed outside the dedicated function, and the function validates
  `app.account_id` and installation ownership;
- legacy first binding remains compatible while legacy takeover requires `0.3.8`;
- current-session recovery renews pairing without violating unique constraints;
- the generated bundle version and SHA-256 match the manifest;
- deployment smoke tests can fetch only the manifest-selected current artifact.

## Acceptance Criteria

On staging, the originally observed `channel_owner_conflict` no longer occurs after the
Bridge updates to `0.3.8`. A new pairing challenge appears, the user's WeChat reply verifies
it, Runtime heartbeats become active, and `/agent` shows Attention → Agent → Bridge → WeChat
connected. A replay from the replaced session is rejected without changing ownership.
