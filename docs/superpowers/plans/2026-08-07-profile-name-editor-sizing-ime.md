# Profile display-name editor implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the inline profile display-name editor grow from a useful minimum width to the currently available profile width, and prevent IME confirmation Enter from saving.

**Architecture:** Put width clamping and Enter eligibility in a small pure behavior module with deterministic unit tests. The React component measures an off-layout typography probe, observes its real container, and feeds those values into the pure width function; the existing mirror remains responsible for wrapped height. Composition state is tracked with composition events and checked together with native browser signals before form submission.

**Tech Stack:** React 19, TypeScript 6, CSS, Vitest 4, pnpm.

## Global constraints

- Preserve the avatar crop editor and toast behavior already present in `ProfileIdentityEditor`.
- The editor minimum width is 160 px unless the current rendered name is wider.
- The maximum width is the actual profile-copy width minus absolute action controls.
- Use the existing font, wrapping mirror, responsive breakpoints, Save, Cancel, Escape, and profile API.
- Do not add a dependency or a new responsive breakpoint.
- Enter during composition or with legacy key code 229 must not submit.
- A later non-composing Enter submits exactly once.

---

### Task 1: Add deterministic editor behavior

**Files:**
- Create: `apps/web/src/components/profile-name-editor-behavior.ts`
- Create: `apps/web/src/components/profile-name-editor-behavior.test.ts`

**Interfaces:**
- Produces: `PROFILE_NAME_EDITOR_MIN_WIDTH_PX: 160`.
- Produces: `profileNameEditorWidth(input): number`, where `input` contains `availableWidth`, `contentWidth`, and `initialWidth`.
- Produces: `shouldSubmitProfileNameEnter(input): boolean`, where `input` contains `key`, `compositionActive`, `nativeIsComposing`, and `keyCode`.

- [ ] **Step 1: Write failing behavior tests**

Create tests that assert the exact cases below:

```ts
expect(profileNameEditorWidth({
  availableWidth: 500,
  contentWidth: 90,
  initialWidth: 80,
})).toBe(160);

expect(profileNameEditorWidth({
  availableWidth: 500,
  contentWidth: 284,
  initialWidth: 120,
})).toBe(284);

expect(profileNameEditorWidth({
  availableWidth: 260,
  contentWidth: 420,
  initialWidth: 180,
})).toBe(260);

expect(profileNameEditorWidth({
  availableWidth: 120,
  contentWidth: 420,
  initialWidth: 180,
})).toBe(120);
```

Also assert that `shouldSubmitProfileNameEnter` returns false for an active React composition, native `isComposing`, key code 229, and non-Enter keys, then true only for an ordinary Enter.

- [ ] **Step 2: Run the tests and verify failure**

Run:

```bash
pnpm vitest run apps/web/src/components/profile-name-editor-behavior.test.ts
```

Expected: FAIL because the behavior module does not exist.

- [ ] **Step 3: Implement the pure behavior module**

Use this clamping policy:

```ts
export const PROFILE_NAME_EDITOR_MIN_WIDTH_PX = 160;

export function profileNameEditorWidth(input: {
  availableWidth: number;
  contentWidth: number;
  initialWidth: number;
}): number {
  const availableWidth = Math.max(0, input.availableWidth);
  const minimumWidth = Math.min(
    availableWidth,
    Math.max(PROFILE_NAME_EDITOR_MIN_WIDTH_PX, input.initialWidth),
  );
  return Math.min(
    availableWidth,
    Math.max(minimumWidth, input.contentWidth),
  );
}
```

Implement `shouldSubmitProfileNameEnter` so it requires `key === "Enter"` and rejects every composition signal.

- [ ] **Step 4: Run the focused tests**

Run:

```bash
pnpm vitest run apps/web/src/components/profile-name-editor-behavior.test.ts
```

Expected: all behavior tests PASS.

- [ ] **Step 5: Commit the behavior unit**

```bash
git add apps/web/src/components/profile-name-editor-behavior.ts apps/web/src/components/profile-name-editor-behavior.test.ts
git commit -m "test: define profile name editor behavior"
```

### Task 2: Wire live sizing and IME-safe Enter into the editor

**Files:**
- Modify: `apps/web/src/components/profile-identity-editor.tsx`
- Modify: `apps/web/src/app/globals.css`
- Create: `apps/web/src/components/profile-identity-editor.test.ts`

**Interfaces:**
- Consumes: `profileNameEditorWidth` and `shouldSubmitProfileNameEnter` from Task 1.
- Preserves: `saveName(event)`, `closeNameEditor()`, avatar selection/cropping, and toast behavior.

- [ ] **Step 1: Write failing integration wiring checks**

The test reads the component and CSS sources and asserts all of the following are present:

```ts
expect(component).toContain("profileNameEditorWidth");
expect(component).toContain("shouldSubmitProfileNameEnter");
expect(component).toContain("new ResizeObserver");
expect(component).toContain("onCompositionStart");
expect(component).toContain("onCompositionEnd");
expect(component).toContain("profile-name-editor__measure");
expect(styles).toContain(".profile-name-editor__measure");
expect(styles).toContain("white-space: pre");
expect(styles).toContain("white-space: pre-wrap");
```

It must also assert that the legacy unconditional `event.key === "Enter"` submit branch is absent.

- [ ] **Step 2: Run the focused tests and verify failure**

Run:

```bash
pnpm vitest run apps/web/src/components/profile-identity-editor.test.ts
```

Expected: FAIL because live measurement and composition wiring are absent.

- [ ] **Step 3: Add live measurement without changing avatar behavior**

In `ProfileIdentityEditor`:

1. Import `useLayoutEffect` and both behavior helpers.
2. Add refs for the profile-copy container, hidden measure span, action group, and active composition flag.
3. Capture the rendered trigger width when editing opens.
4. While editing, measure the hidden unwrapped draft and the profile-copy container.
5. When actions are absolutely positioned, subtract their rendered width plus the existing 8 px gap.
6. Set `editorWidth` through `profileNameEditorWidth`.
7. Observe the profile-copy container with `ResizeObserver`; disconnect it on cleanup.
8. Render a `profile-name-editor__measure` span containing the draft.
9. Attach the profile-copy and action refs.
10. Track composition start/end on the textarea.
11. Submit Enter only when `shouldSubmitProfileNameEnter` returns true. Leave composing Enter unprevented so the IME can confirm its candidate.

Keep the form width style and existing mirror/textarea grid. Do not edit avatar crop calculations, modal focus management, or toast timing.

- [ ] **Step 4: Add the off-layout typography probe styles**

Give `.profile-name-editor__measure` the same font family, size, weight, letter spacing, line height, padding, and border-box sizing as the textarea. Keep it fixed outside the viewport, invisible, non-interactive, `width: max-content`, and `white-space: pre`. Retain `white-space: pre-wrap` and `overflow-wrap: anywhere` on the existing mirror and textarea.

- [ ] **Step 5: Run focused validation**

Run:

```bash
pnpm vitest run apps/web/src/components/profile-name-editor-behavior.test.ts apps/web/src/components/profile-identity-editor.test.ts
pnpm --filter @attention/web typecheck
pnpm eslint apps/web/src/components/profile-name-editor-behavior.ts apps/web/src/components/profile-name-editor-behavior.test.ts apps/web/src/components/profile-identity-editor.tsx apps/web/src/components/profile-identity-editor.test.ts
git diff --check
```

Expected: tests, typecheck, lint, and whitespace checks PASS.

- [ ] **Step 6: Commit the integrated fix**

```bash
git add apps/web/src/components/profile-name-editor-behavior.ts apps/web/src/components/profile-name-editor-behavior.test.ts apps/web/src/components/profile-identity-editor.tsx apps/web/src/components/profile-identity-editor.test.ts apps/web/src/app/globals.css
git commit -m "fix: grow profile name editor safely"
```

### Task 3: Verify the complete change

**Files:**
- Verify only; no additional source files are expected.

**Interfaces:**
- Consumes the completed editor implementation.
- Produces release evidence for unit behavior, integration wiring, types, lint, and build.

- [ ] **Step 1: Run the complete relevant test suite**

```bash
pnpm vitest run apps/web/src/components/profile-name-editor-behavior.test.ts apps/web/src/components/profile-identity-editor.test.ts apps/web/src/app/api/account/profile/route.test.ts
```

Expected: all tests PASS.

- [ ] **Step 2: Run package and repository checks**

```bash
pnpm --filter @attention/web typecheck
pnpm eslint apps/web/src/components/profile-name-editor-behavior.ts apps/web/src/components/profile-name-editor-behavior.test.ts apps/web/src/components/profile-identity-editor.tsx apps/web/src/components/profile-identity-editor.test.ts
pnpm --filter @attention/web build
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 3: Review the final diff**

Confirm the diff changes only the behavior helper/tests, display-name section of `ProfileIdentityEditor`, matching editor CSS, the approved spec, and this plan. Confirm avatar crop and toast code are unchanged from `origin/main`.

- [ ] **Step 4: Report completion**

Report the sizing rules, IME behavior, verification commands and results, and any remaining deployment step. Do not claim deployment unless staging was actually updated.
