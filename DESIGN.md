---
name: Attention
description: 人筛选，AI 整理的信息层与个人收藏工具
colors:
  canvas: "#ffffff"
  surface: "#fefefe"
  surface-muted: "#f4f4f5"
  surface-input: "#fbfdfc"
  ink: "#1d1d1f"
  muted: "#707075"
  line: "#e6e6e2"
  line-strong: "#d8d8d4"
  ai-signal: "#0066ff"
  ai-signal-hover: "#005be6"
  ai-soft: "#eaf2ff"
  ai-summary-soft: "#f5f7ff"
  human-signal: "#ff6b5f"
  human-soft: "#fff0ee"
  human-ink: "#63221c"
  success: "#147d64"
  danger: "#c43228"
  warning: "#8a6500"
typography:
  display:
    fontFamily: "SF Pro Display, PingFang SC, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "2rem"
    fontWeight: 650
    lineHeight: 1.15
    letterSpacing: "-0.03em"
  title:
    fontFamily: "SF Pro Text, PingFang SC, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "17px"
    fontWeight: 650
    lineHeight: 1.35
    letterSpacing: "-0.02em"
  body:
    fontFamily: "SF Pro Text, PingFang SC, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.625
  label:
    fontFamily: "SF Pro Text, PingFang SC, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "12px"
    fontWeight: 650
    lineHeight: 1.4
  data:
    fontFamily: "SFMono-Regular, SF Mono, ui-monospace, Consolas, monospace"
    fontSize: "11px"
    fontWeight: 700
    lineHeight: 1.4
rounded:
  control: "12px"
  card: "16px"
  nav: "9px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  card: "20px"
  xl: "24px"
  section: "32px"
zIndex:
  header: 20
  sticky: 30
  modalBackdrop: 90
  modal: 100
  toast: 110
  skipLink: 120
components:
  button-primary:
    backgroundColor: "{colors.ai-signal}"
    textColor: "{colors.surface}"
    rounded: "{rounded.pill}"
    padding: "9px 16px"
    height: "44px"
  button-primary-hover:
    backgroundColor: "{colors.ai-signal-hover}"
    textColor: "{colors.surface}"
    rounded: "{rounded.pill}"
    padding: "9px 16px"
    height: "44px"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "9px 16px"
    height: "44px"
  settings-card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.card}"
    padding: "{spacing.card}"
  settings-nav-item:
    backgroundColor: "{colors.surface-muted}"
    textColor: "{colors.ink}"
    rounded: "{rounded.nav}"
    padding: "7px 8px"
    height: "44px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "44px"
---

# Design System: Attention

## Overview

**Creative North Star: “Quiet Signal”**

Attention is a product interface for trusting information to a system without giving up human judgment. The visual language is quiet, compact, and legible: black, white, and neutral gray carry the surface; blue marks AI, links, and the next useful action; coral marks a human filter or recommendation. The interface should disappear into the user's workflow after the meaning of each state is clear.

The system explicitly rejects warm paper surfaces, marketing-page theatrics, dashboard decoration, gratuitous gradients, glass cards, large shadows, and duplicated entrances for the same task. Settings are organized as a stable side navigation plus a sequence of focused surfaces. A state is described first, then its action is offered.

**Key Characteristics:**

- Neutral surfaces with one semantic accent at a time.
- Compact product typography with stable rem/px steps.
- 16px cards, 12px controls, and 8px internal rhythm.
- Blue primary actions; neutral secondary actions.
- Inline and modal flows used only when they preserve context.

## Colors

The palette is restrained and neutral. Color is semantic rather than decorative, and inactive states stay quiet.

### Primary

- **Signal Blue** (`#0066ff`): Primary actions, links, focus rings, and AI affordances.
- **Signal Blue Hover** (`#005be6`): Hover state for primary actions.

### Secondary

- **Human Coral** (`#ff6b5f`): Human curation, recommendation, and attention markers.
- **Success Green** (`#147d64`): Successful, available, or public states.

### Tertiary

- **Danger Red** (`#c43228`): Errors, blocked actions, and unsafe states.
- **Warning Ochre** (`#8a6500`): Pending, risk, or confirmation-required states.

### Neutral

- **Canvas White** (`#ffffff`): Page background.
- **Surface White** (`#fefefe`): Cards, forms, and modal sheets.
- **Muted Surface** (`#f4f4f5`): Selected navigation, secondary panels, and disabled context.
- **Input Surface** (`#fbfdfc`): Text areas and text fields that need a quiet inset surface.
- **Ink** (`#1d1d1f`): Headings, body text, and primary control text.
- **Muted Ink** (`#707075`): Explanations and metadata.
- **Line** (`#e6e6e2`) / **Strong Line** (`#d8d8d4`): Borders and field boundaries.

**The One Accent Rule.** A surface earns one primary accent. Do not combine blue and coral as decoration; each color must explain a different product state.

## Typography

**Display Font:** SF Pro Display with PingFang SC and system fallbacks

**Body Font:** SF Pro Text with PingFang SC and system fallbacks
**Label/Mono Font:** SFMono-Regular / SF Mono for compact data and technical state labels

**Character:** One sans family system keeps the product familiar and avoids a marketing/editorial split. Display sizing is reserved for page titles; controls, labels, and data stay fixed and compact.

### Hierarchy

- **Display** (650, `2rem`, `1.15`): Settings page titles and similarly scoped product headings.
- **Title** (650, `17px`, `1.35`): Card titles and task titles.
- **Body** (400, `16px`, `1.625`): Main prose, capped around 65–75ch where it is explanatory.
- **Label** (650, `12px`, `1.4`): Field labels and navigation labels.
- **Data** (700, `11px`, `1.4`): Status values, timestamps, and system metadata.

**The Plain Action Rule.** Use direct action language—“登录”, “保存”, “订阅”, “管理订阅”—and keep system terminology out of user-facing labels.

## Elevation

Attention is flat by default. Depth comes from a solid surface, a 1px border, and spacing between tasks. Shadows are reserved for overlays and should not be paired with decorative ghost-card borders on ordinary content.

### Shadow Vocabulary

- **Modal ambient** (`0 28px 80px rgba(0, 0, 0, 0.18)`): Modal sheets only.
- **Navigation ambient** (`0 10px 35px rgba(0, 0, 0, 0.12)`): Floating mobile navigation only.

**The Flat Surface Rule.** Cards do not float at rest. If a component needs more emphasis, change its state, border, or placement before adding a shadow.

## Components

### Buttons

- **Shape:** Full pill for actions (`999px`), 44px minimum height, 9px 16px padding.
- **Primary:** Signal Blue with white text; use for the single main action on a surface.
- **Secondary:** Surface white with strong line and ink text; use for management, cancel, or alternate actions.
- **Hover / Focus:** Primary shifts to Signal Blue Hover; all controls retain a visible blue focus ring; transitions use 140ms ease for simple state feedback.

### Chips

- **Style:** Status chips use a 1px border, 999px radius, and a semantic text color; do not use saturated backgrounds for inactive states.
- **State:** Active subscription status may use blue text; Free and disabled states remain muted.

### Cards / Containers

- **Corner Style:** `16px` for settings/content cards; `12px` for inputs; `9px` for sidebar items.
- **Background:** `--surface` over `--canvas`, with `--surface-muted` for selected or secondary context.
- **Shadow Strategy:** Flat at rest; modal-only ambient shadow.
- **Border:** 1px `--line` by default, `--line-strong` for controls.
- **Internal Padding:** 20px card padding; 8px internal rhythm; 16px minimum between explanatory copy and its action.

### Inputs / Fields

- **Style:** `--surface`, 1px `--line-strong`, 12px radius, 44px minimum height, 12px horizontal padding.
- **Focus:** Ink/strong boundary plus a visible blue focus ring.
- **Error / Disabled:** Use text plus `--danger` for errors; preserve layout and reduce contrast for disabled states.

### Navigation

- **Style:** Settings sidebar is 152px wide with 44px navigation items, 7px 8px padding, 9px radius, and 17px icons.
- **Active:** Selected items use `--surface-muted` and ink text; inactive items use muted ink.
- **Mobile:** The side navigation becomes a horizontal scroll row; the primary task remains visible and touch targets remain at least 44px.

### Settings Status Card

The membership card uses a left status explanation and a right status/action group. “订阅” is primary blue only when no subscription exists; “管理订阅” is secondary when an active subscription exists. Cross-page membership links open a new tab and carry an inline up-right arrow at the same size as the label text.

### Contextual Collection Modal

The global “收藏链接” entry opens a modal collection workbench instead of navigating away. The modal uses a neutral overlay, a 680px maximum sheet, a compact text area, Escape/backdrop/close-button dismissal, keyboard focus containment, focus return to the trigger, and a bottom-sheet layout below 600px.

## Do's and Don'ts

### Do:

- **Do** use `--canvas`, `--surface`, and `--surface-muted` for neutral layers.
- **Do** use blue for the main action and a neutral secondary button for management actions.
- **Do** use 16px cards, 12px controls, 9px sidebar items, and the 4/8/12/16/20/24/32 spacing scale.
- **Do** describe state before action: show the subscription status before “订阅” or “管理订阅”.
- **Do** keep collection, digest, membership, and security tasks in their appropriate inline or contextual surfaces.
- **Do** support keyboard focus, Escape dismissal, reduced motion, narrow screens, and increased text size.

### Don't:

- **Don't** use warm beige, paper, parchment, or magazine-warm page backgrounds.
- **Don't** use a marketing landing-page hierarchy, repeated slogans, decorative metrics, or an oversized card wall in settings.
- **Don't** use meaningless gradients, glassmorphism, glowing effects, or wide decorative shadows.
- **Don't** use a colored side stripe thicker than 1px; use a full border, semantic background, icon, or heading instead.
- **Don't** expose unsupported capabilities such as a fake payment management portal or an unsupported delivery channel.
- **Don't** call a fixed send time a “送达窗口”; use “发送时间” when that is the user decision.
- **Don't** duplicate the same task in both sidebar navigation and a contextual card without a clear reason.
