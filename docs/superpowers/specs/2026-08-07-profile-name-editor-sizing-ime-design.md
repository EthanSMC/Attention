# Profile display-name editor sizing and IME design

Date: 2026-08-07
Status: approved

## Problem

The inline display-name editor copies the rendered name button's width into a
fixed form width. Longer edits therefore wrap inside the old, often narrow,
box before the surrounding profile layout is actually out of space.

The editor also submits every Enter keydown. During Chinese and other IME
composition, the Enter used to accept a candidate can therefore save the
profile before composition has finished.

## Desired behavior

1. Opening the editor preserves the current rendered name width as its minimum
   width so the control does not collapse.
2. As the draft grows, the editor grows horizontally using the same font
   metrics as the visible field.
3. Growth stops at the existing profile-copy content width. At that point the
   current wrapping and mirror-based height behavior continues unchanged.
4. Resizing the page recalculates the available width without adding a new
   responsive breakpoint.
5. Escape cancels. Enter outside composition saves. Enter while an IME is
   composing only confirms the IME candidate and never submits the form.
6. The explicit Save and Cancel buttons keep their existing behavior.

## Component design

`ProfileIdentityEditor` retains the existing hidden mirror, draft state, and
form submission path. It adds focused sizing behavior with three inputs:

- the rendered name width captured when editing begins;
- the unwrapped draft width measured with the editor's actual typography;
- the current width available inside `.account-profile__copy`.

The form width is the draft width clamped between the captured minimum and the
available content width. The visible textarea and wrapping mirror continue to
share a grid cell, so reaching the maximum width naturally uses the existing
line wrapping and height calculation.

The sizing calculation reruns when the draft changes and when the containing
profile-copy region resizes. A `ResizeObserver` is preferred over a new window
breakpoint because it follows the actual layout constraint.

## IME handling

The textarea must treat an Enter keydown as composition input when either the
React keyboard event or its native event reports `isComposing`. Key code 229
is retained as a compatibility fallback for browsers that end composition
before React receives the keydown. Composition Enter is not prevented and does
not request form submission. A later, non-composing Enter prevents a newline
and submits through the existing form path.

## Accessibility and failure behavior

The editor keeps its label, autofocus, visible focus treatment, maximum length,
buttons, and server-side validation. If measurement is unavailable, it falls
back to the captured minimum width and the existing CSS maximum, leaving the
editor usable. Saving errors continue to use the existing toast.

## Verification

Regression coverage must prove:

- the minimum width is captured when editing opens;
- longer drafts increase the requested editor width;
- width is capped by the current container and the mirror can wrap;
- a container resize triggers recalculation;
- composing Enter does not submit;
- non-composing Enter submits once;
- Escape, Save, and Cancel retain their existing behavior.

The implementation must preserve the unrelated in-progress avatar editor and
toast changes already present in the same component and stylesheet.
