# Attention UI / UX Integrity Audit

Date: 2026-08-12  
Frozen product commit: `49ffb2a`  
Audit rule: production UI code remained unchanged while this report was produced.

## Scope

The walkthrough covered guest and authenticated states across desktop and a real 390 px layout viewport:

- Discovery, paywall preview, collect login gate, login module, authenticated collect.
- Account collection, account profile settings, connections, API Key creation.
- Codex and Claude Code MCP OAuth consent, loopback completion, connection grouping, duplicate-name replacement.
- Documentation index and Claude Code detail, membership.
- Keyboard and semantic checks on the OAuth replacement dialog.
- Console warnings/errors and document-level horizontal overflow.

The local fixture contained 25 mixed-source collection cards, a Member + Filter account, real local DCR/PKCE clients for Codex and Claude Code, and successful authorization-code exchanges for both hosts.

## Executive result

Codex and Claude Code now reach the same Attention-owned experience:

- The same resident-channel capability contract and 20-turn replay fallback.
- The same MCP scope set and consent page.
- The same required connection naming, duplicate detection, replacement confirmation, loopback completion page, and settings representation.
- One independently revocable logical connection per host/device name.

No P0 defect was found. The remaining integrity work is primarily cross-page chrome, mobile obstruction, modal accessibility, and information hierarchy.

## Scorecard

| Dimension | Score | Notes |
| --- | ---: | --- |
| Accessibility | 3 / 4 | Labels, skip links, landmarks and visible focus exist. The replacement dialog lacks an explicit focus lifecycle. |
| Responsive layout | 3 / 4 | All audited 390 px documents reported `scrollWidth === clientWidth`; two fixed/scrolling navigation patterns still reduce usability. |
| Visual system | 4 / 4 | Quiet Signal colors, radii, typography, spacing and restrained surfaces remain consistent. |
| Runtime quality | 4 / 4 | No browser warning/error was observed in the audited flows. |
| Anti-pattern avoidance | 3 / 4 | Consent is transparent but overly flat; global navigation and the collect action intrude on focused tasks. |
| **Total** | **17 / 20** | Strong baseline with a bounded remediation set. |

## Findings

### P1-01 — Replacement dialog has no explicit keyboard focus lifecycle

- Surface: `/oauth/authorize`, duplicate connection → replacement confirmation.
- Component: `apps/web/src/components/oauth-authorization-form.tsx:389`.
- Evidence: `output/playwright/ui-audit-2026-08-12/13-oauth-codex-replace-modal-desktop.png`, `22-oauth-replace-modal-mobile-frame.png`.
- Observed: the dialog has `role="dialog"` and `aria-modal="true"`, but opening/closing is only reducer state. There is no initial-focus effect, Escape handler, focus containment, or restoration to the trigger.
- Impact: keyboard and assistive-technology users can lose context or move into inert-looking content behind a modal security decision.
- Rule: a modal decision must own focus while open and return it predictably when closed.
- Recommendation: add a dialog ref, focus the safe secondary action on open, handle Escape as “返回修改”, contain Tab within the two actions, and restore focus to “继续并替换”.

### P2-01 — Fixed “收藏链接” action obscures focused mobile content

- Surfaces: `/membership`, `/account/settings`, and other long form/settings routes.
- Component: `apps/web/src/components/site-navigation.tsx:151`.
- CSS: `apps/web/src/app/globals.css:6479` and `apps/web/src/app/globals.css:6513`.
- Evidence: `output/playwright/ui-audit-2026-08-12/17-settings-profile-mobile-frame.png`, `20-membership-mobile-frame.png`.
- Observed: the fixed action is rendered on every non-document route and occupies content space without reserving it. On mobile membership it overlays the Member plan copy; on settings it can cover lower fields/actions while scrolling.
- Impact: a global shortcut competes with the current task and can hide information or controls.
- Rule: fixed actions must not cover task content and should not appear when unrelated to the current workflow.
- Recommendation: hide the action on OAuth, auth, membership, and account-settings routes; retain it on discovery and collection-oriented pages. Keep existing mobile safe-area positioning where it remains.

### P2-02 — OAuth consent includes unrelated global navigation and collection action

- Surface: `/oauth/authorize` for both Codex and Claude Code.
- Components: `apps/web/src/components/site-navigation.tsx:103`, `apps/web/src/app/oauth/authorize/page.tsx:170`.
- Evidence: `output/playwright/ui-audit-2026-08-12/09-oauth-codex-empty-name-desktop.png`, `10-oauth-claude-empty-name-desktop.png`.
- Observed: the authorization ceremony is visually embedded in the full product shell, including Discover, Account, Settings, mobile navigation, and the collection FAB.
- Impact: unrelated exit paths and actions dilute an account-permission decision and make the mobile page longer/noisier.
- Rule: security ceremonies should be calm, focused, and clearly scoped to the client, account, permissions, and two decisions.
- Recommendation: use a focused OAuth chrome: Attention brand/back-to-product affordance only; suppress global navigation and collect controls for `/oauth/*`.

### P2-03 — Password recovery discards the caller’s intended return path

- Surface: login module reached from collection or another protected route, then password mode → “忘记密码？”.
- Component: `apps/web/src/components/email-login-form.tsx:183`.
- Observed: the link hard-codes `/login?return_to=/account/settings` instead of preserving the form’s `returnTo` value. A user who began at `/collect` is silently redirected toward settings.
- Impact: breaks task continuity and makes login feel unrelated to the action that required it.
- Rule: authentication must preserve a safe, validated return destination through every method switch and recovery step.
- Recommendation: generate the recovery link from the existing safe `returnTo` prop and add a regression test for `/collect`.

### P2-04 — Permission disclosure is transparent but too flat

- Surface: `/oauth/authorize` for both Codex and Claude Code.
- Component: `apps/web/src/app/oauth/authorize/page.tsx:177`.
- CSS: `apps/web/src/app/globals.css:4258`.
- Evidence: `09-oauth-codex-empty-name-desktop.png`, `10-oauth-claude-empty-name-desktop.png`.
- Observed: all 12 permissions are presented as one undifferentiated list with line-height 2. The exact permissions are correct and consistent, but the hierarchy is difficult to scan—especially before the connection-name decision on mobile.
- Impact: users are less likely to understand the permission categories even though every item is technically disclosed.
- Rule: security copy should preserve exactness while using progressive disclosure and meaningful grouping.
- Recommendation: group permissions into Collection/Public, AI/Digest, Community Moderation, and Account; keep every exact permission visible or available in an expanded details block. Codex and Claude Code must render from the same data structure.

### P2-05 — Mobile documentation does not reveal the active off-screen document tab

- Surface: `/doc/claude-code` at 390 px.
- Component: `apps/web/src/components/agent-doc-navigation.tsx:18`.
- CSS: `apps/web/src/app/globals.css:7277`.
- Evidence: `output/playwright/ui-audit-2026-08-12/23-doc-claude-code-mobile-frame.png`.
- Observed: the horizontally scrolling document list starts at “概览”; the active “Claude Code” tab is off-screen and is not scrolled into view. The hidden scrollbar provides no active-position cue.
- Impact: the page heading identifies the document, but the navigation does not communicate location or neighboring documents.
- Rule: the active item in a scrollable navigation must be visible on entry.
- Recommendation: make the navigation client-aware and call `scrollIntoView({ inline: "center", block: "nearest" })` for the active link; retain the current pill styling.

### P3-01 — Empty connection name is shown as an error before interaction

- Surface: `/oauth/authorize` initial state.
- Component: `apps/web/src/components/oauth-authorization-form.tsx:454` and `apps/web/src/components/oauth-authorization-form.tsx:487`.
- Evidence: `09-oauth-codex-empty-name-desktop.png`, `10-oauth-claude-empty-name-desktop.png`.
- Observed: an empty field immediately produces an alert-style validation message before the user has edited or submitted the form.
- Impact: minor; the first impression is corrective instead of instructive.
- Rule: untouched required fields should use helper text; error semantics should begin after interaction or submission.
- Recommendation: keep the primary action disabled and show neutral guidance until the field is touched.

### P3-02 — Horizontal pill navigation hides overflow affordance

- Surfaces: mobile settings and documentation.
- CSS: `apps/web/src/app/globals.css:6242` and `apps/web/src/app/globals.css:7277`.
- Evidence: `17-settings-profile-mobile-frame.png`, `19-doc-mobile-frame.png`, `23-doc-claude-code-mobile-frame.png`.
- Observed: horizontal scrolling works and does not create document overflow, but the scrollbar is deliberately hidden and there is no edge fade or continuation cue.
- Impact: users may not discover later tabs.
- Recommendation: add a subtle right-edge mask/gradient or trailing chevron that disappears at the end; do not add another navigation pattern.

## Confirmed passes

- Codex and Claude Code consent content, action count, callback copy, and settings grouping are structurally identical.
- Duplicate-name flow always exposes two decisions: cancel/modify and continue/replace.
- Mobile document widths for all audited routes were exactly 390 px with no document-level horizontal overflow.
- Public cards and personal collection cards share the same card grammar.
- Source identity, original-link action, AI-summary status, public/private state, and ownership remain legible.
- The documentation site uses the product palette and two-column desktop structure requested by the product design.
- No warning or error appeared in browser logs during the final authenticated walkthrough.

## Evidence index

Local screenshots are stored under:

`output/playwright/ui-audit-2026-08-12/`

The highest-signal files are:

- `09-oauth-codex-empty-name-desktop.png`
- `10-oauth-claude-empty-name-desktop.png`
- `11-connections-codex-claude-desktop.png`
- `12-oauth-codex-duplicate-inline-desktop.png`
- `13-oauth-codex-replace-modal-desktop.png`
- `17-settings-profile-mobile-frame.png`
- `20-membership-mobile-frame.png`
- `21-oauth-duplicate-mobile-frame.png`
- `22-oauth-replace-modal-mobile-frame.png`
- `23-doc-claude-code-mobile-frame.png`

Responsive screenshots use a disposable 390 × 844 iframe shell so the audited application receives a true 390 px layout viewport without altering product code. The gray area outside the frame is the audit shell, not part of Attention.
