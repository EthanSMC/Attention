# Unified Agent OAuth Consent Design

**Date:** 2026-08-17

**Status:** Approved direction; pending written-spec review

**Surface:** `/oauth/authorize` and Account → Connections & Authorization

**Audiences:** `attention-mcp`, `attention-sync`, `attention-channel-runtime`

## Goal

Give every Agent and local-channel OAuth flow one quiet, user-readable consent experience modeled on Robinhood's information order. The consent page must help a normal user decide whether to grant access without exposing protocol implementation details or requiring connection-management work first.

The page answers, in order:

1. Who wants to access the user's Attention account.
2. What that client will be able to do.
3. Which user data it may encounter.
4. Which security boundary remains in place.
5. Where access can be revoked.
6. Which privacy policy applies.
7. How to allow or refuse the request.

## Accepted Product Decisions

- The heading is `“{clientName} 想要访问你的 Attention”`.
- Do not show requester or Attention logos, initials, avatars, verification badges, or “name supplied by client” disclaimers.
- Do not show callback hosts, redirect URIs, resource identifiers, raw OAuth scopes, PKCE terminology, or other protocol details anywhere in the user interface.
- Client admission and impersonation prevention remain server/security responsibilities, not consent-page explanations.
- Permissions are grouped into user tasks. Only groups represented by the validated requested scopes appear.
- The page explicitly describes the data the client may encounter.
- The page states that the Attention login Session is never given to the client.
- The page links to Account → Connections & Authorization for revocation and links to the Attention privacy policy.
- The final actions are `允许并连接` and `拒绝`.
- The user no longer names a connection during consent.
- Runtime initially uses the server-trusted device name. MCP and Sync initially use the OAuth client name. Active-name collisions receive numeric suffixes such as `Codex 2` and `Codex 3` without replacing an existing connection.
- Users can rename active OAuth connections later from Account → Connections & Authorization.

## Non-goals

- Building a publisher-verification program or showing trust badges.
- Letting users select or remove individual scopes during consent.
- Changing OAuth protocol validation, PKCE, resource binding, token lifetimes, or account entitlement enforcement.
- Showing a developer/debug detail disclosure on the consent page.
- Redesigning API Key creation beyond reusing the user-readable permission presentation where appropriate.

## Shared Consent Presentation Model

Add one server-safe, pure presentation module that converts a validated OAuth audience and scope set into user-readable content. Both the consent page and the connection-management page consume this module so their vocabulary cannot drift.

Conceptual output:

```ts
interface OAuthConsentPresentation {
  permissionGroups: Array<{
    id: string;
    title: string;
    description: string;
    risk?: "write" | "irreversible";
  }>;
  dataItems: string[];
  audienceSummary: string;
}
```

The function accepts only an already validated audience and scopes. Every supported scope must be covered by exactly one user-facing permission group and at least one data-range statement where it exposes account data. If a future valid scope lacks presentation metadata, the page must fail closed with a generic “暂时无法显示这个授权请求” state and no allow action. It must never fall back to rendering the raw scope string.

### MCP permission groups

Render only groups whose scopes were actually requested.

| User-facing group | Covered scopes | User-facing meaning |
|---|---|---|
| 查看账号与私人收藏 | `profile:read`, `subscription:read`, `collection:read` | View the user's public profile, membership/subscription state, and private saved links available to the client. |
| 新增私人收藏 | `collection:write` | Add new private saved links for the user; this does not imply edit or delete permission. |
| 查看和修改日报 | `digest:read`, `digest:write` | View digest subscription/send time and modify them when write access is requested. Copy must adapt when only read access is present. |
| 使用公开内容与 AI 检索 | `public:read`, `public:full`, `ai:search` | Read the public content available under the account's current entitlement and use hosted AI retrieval when requested. Member-only abilities remain checked on every call. |
| 参与公开治理 | `moderation:write`, `moderation:court:read`, `moderation:court:vote` | Report public content, view current court information, and—only after explicit per-action confirmation—submit an irreversible vote when the vote scope is present. |

MCP data-range statements are generated from the requested groups and may include public profile and membership/subscription state, private saved-link URLs and metadata, digest configuration, public-content results, and moderation case/vote records. The page must not claim access to data that is absent from the requested scopes.

### Sync permission groups

| User-facing group | Covered scopes | User-facing meaning |
|---|---|---|
| 同步你的私人收藏 | `sync:read`, `sync:write` | Download and/or upload private collection changes according to the requested direction. |

Sync data range includes saved-link URLs, collection state, and the server-derived metadata that participates in sync. Copy adapts to read-only, write-only, or read/write requests.

### Runtime/channel permission groups

| User-facing group | Covered scopes | User-facing meaning |
|---|---|---|
| 连接本地 Agent | `runtime:register` | Register this trusted local Agent installation with the user's Attention account. |
| 上报运行状态 | `runtime:heartbeat` | Report device/runtime health, recent activity, and privacy-safe queue status. |
| 同步渠道连接状态 | `channel:bind:report`, `channel:disconnect:report` | Report whether a local channel was connected, verified, or disconnected. |

Runtime data range includes the trusted device name, Agent host identity, runtime health timestamps/status, privacy-safe queue counts, and opaque channel-binding verification state. It explicitly excludes conversation content, saved links, provider credentials, and local session material.

## Consent Page Information Architecture

`/oauth/authorize` is a standalone security surface.

1. **Heading** — `“{clientName} 想要访问你的 Attention”`.
2. **Current account** — identify the Attention account being used.
3. **Permission groups** — vertical bordered sections with a task title and concise consequence. These are not a decorative equal-card grid.
4. **Data range** — a short, deduplicated list headed `授权后可能接触的数据`.
5. **Security and revocation** — state that the website login Session is not shared and that access can be revoked at any time from `连接与授权`.
6. **Privacy** — link to `/privacy` in a new tab with a clear accessible name.
7. **Actions** — primary `允许并连接`; secondary `拒绝`.

The route hides the global site header, collection floating action, and mobile navigation. It uses Attention's neutral canvas, blue primary action, flat borders, 16px container radius, existing type system, 44px minimum controls, and no decorative motion.

The page contains no connection-label field and no replacement modal. Submission exposes a pending state, prevents duplicate submission, and announces progress to assistive technology.

## Automatic Connection Naming

### Generic MCP and Sync

The base label is the validated OAuth client name, normalized through the existing connection-label normalization rules. Connection creation chooses the first available active label within the account and audience:

```text
Codex
Codex 2
Codex 3
…
```

The numeric suffix is appended after truncating the base as necessary to preserve the 80-character limit. Name allocation happens when the connection is materialized during token exchange, not when the browser page is rendered, so it reflects the latest active connections.

Connection insertion uses `ON CONFLICT DO NOTHING` against the existing active-name unique index and retries the next suffix. This makes concurrent grants deterministic without replacing or revoking an existing connection. Exhaustion returns `invalid_grant` rather than silently reusing or replacing a name.

### Runtime/channel

For a new trusted installation, the initial label is the trusted DCR device name. The trusted installation key remains the stable identity.

When the same installation reauthorizes, it rotates the existing connection and credentials. It preserves the user's current connection label instead of resetting a later manual rename to the device name. The trusted device name remains separate immutable metadata and continues to identify the physical installation.

## Rename in Connections & Authorization

Add a same-account update operation for one active OAuth connection.

- Endpoint: `PATCH /api/account/oauth/[connectionId]`.
- Body: `{ "label": string }`.
- Normalize with the existing NFKC/whitespace/length rules.
- Update only the user-facing label and normalized label.
- Never change client ID, audience, kind, trusted device name, installation identity, scopes, credentials, or authorization timestamps.
- A duplicate active label in the same account and audience returns HTTP 409 with a stable user-recoverable error code.
- Missing/revoked/cross-account connections return the existing non-disclosing not-found behavior.

In the connection list, a `重命名` control opens a compact inline edit state with a real label, `保存`, and `取消`. Success updates the row without a page reload and announces confirmation. Error text remains adjacent to the field. Runtime rows may show the trusted device name separately so renaming the label does not imply changing the device identity.

Replace the current raw-scope disclosure in the settings page with the same user-facing permission-group titles used on the consent page. Raw scopes do not appear in the UI.

## Privacy Policy Update

The existing Attention privacy policy must add a third-party OAuth section explaining:

- a connected client receives only data permitted by the granted capabilities and current account entitlement;
- Attention does not give the client the website login Session;
- after data is delivered to a third-party client, that client is responsible for its own processing;
- users can revoke future access from Connections & Authorization;
- revocation stops future authorized access but does not claim to delete data a third party already received.

The consent page links to this policy. It does not invent or link a client privacy policy because the current registration model does not provide a verified policy URL.

## Error Handling

- Invalid, expired, unsupported, or incompletely mapped authorization requests show a plain user message and a route back to the requesting client when safe. Raw OAuth error codes and technical fields are not shown.
- Refusal continues through the OAuth cancel route and returns the protocol-appropriate denial to the client.
- Consent submission is idempotence-protected in the browser and continues to be fully revalidated on the server.
- Automatic label conflicts never trigger replacement. They allocate the next suffix.
- Runtime installation conflicts continue to fail closed.
- Rename validation and conflicts preserve the user's typed value and explain the recovery action.

## Accessibility and Responsive Behavior

- Semantic heading hierarchy and lists describe permissions/data.
- The allow action receives visible focus and a live pending state; refusal remains a normal focusable action.
- All controls are at least 44px high and maintain WCAG 2.2 AA contrast.
- At narrow widths, actions stack full-width after the consent information; no fixed product navigation competes for the thumb zone.
- The page remains usable at 200% zoom and does not rely on color to communicate write or irreversible risk.
- Reduced-motion support is preserved; no page-load choreography is added.

## Test Strategy

Follow red-green-refactor for each behavior.

### Presentation-model tests

- Every supported OAuth scope maps to one user-facing group.
- MCP, Sync, and Runtime combinations produce only relevant groups and accurate data ranges.
- Read-only and read/write copy differ correctly.
- Irreversible governance language appears only when vote permission is requested.
- Unknown/incomplete mappings fail closed and never expose raw scope strings.

### Consent-page tests

- Heading, current account, grouped permissions, data range, Session boundary, revoke path, privacy link, and exact action labels render.
- Client/Attention logos, initial avatar, connection-label input, callback, redirect URI, resource, PKCE, and raw scopes do not render.
- Global header, collection FAB, and mobile navigation are absent on OAuth routes.
- Submission pending and refusal behavior are accessible.
- Invalid requests do not display raw error codes.

### Connection-lifecycle tests

- MCP/Sync use client name for the first connection and allocate numeric suffixes for collisions.
- Long labels truncate safely before suffixing.
- Concurrent inserts use the next suffix without replacing existing connections.
- Runtime initial connection uses trusted device name.
- Runtime reauthorization rotates the same connection and preserves a later user rename.
- No generic authorization path revokes an existing connection because of a name collision.

### Rename tests

- Same-account active connection can be renamed.
- Normalization and length rules apply.
- Same-audience duplicate returns 409 and preserves input.
- Cross-account, missing, and revoked targets do not disclose connection existence.
- Runtime rename changes only the label, not trusted device metadata.
- Settings UI supports save/cancel, success announcement, and inline recovery.

### Regression verification

- Existing OAuth request validation, PKCE, cancel, token exchange, resource binding, entitlement enforcement, revocation, and Runtime installation-identity tests remain green.
- Run targeted OAuth/component tests, workspace typecheck, lint for touched files, and the production Web build.
- If the local database is migrated and available, visually inspect representative MCP, Sync, and Runtime consent requests at desktop and mobile widths. If it is unavailable, report that limitation rather than presenting a synthetic error page as the final consent UI.

## Rollout and Compatibility

- Existing active connection labels remain unchanged.
- Existing authorization codes created before deployment continue through the current stored-label path until expiry.
- Newly issued generic authorization codes use automatic materialization.
- Existing Runtime installation identity and credential rotation remain authoritative.
- No database migration is required for automatic naming or rename because the label columns and active-name unique index already exist.
