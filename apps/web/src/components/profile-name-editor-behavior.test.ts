import { describe, expect, it } from "vitest";

import {
  PROFILE_NAME_EDITOR_MIN_WIDTH_PX,
  profileNameEditorWidth,
  shouldSubmitProfileNameEnter,
} from "./profile-name-editor-behavior";

describe("profileNameEditorWidth", () => {
  it("starts at the design minimum when the rendered name is narrower", () => {
    expect(PROFILE_NAME_EDITOR_MIN_WIDTH_PX).toBe(160);
    expect(
      profileNameEditorWidth({
        availableWidth: 500,
        contentWidth: 90,
        initialWidth: 80,
      }),
    ).toBe(160);
  });

  it("grows to the measured draft width", () => {
    expect(
      profileNameEditorWidth({
        availableWidth: 500,
        contentWidth: 284,
        initialWidth: 120,
      }),
    ).toBe(284);
  });

  it("stops at the available layout width", () => {
    expect(
      profileNameEditorWidth({
        availableWidth: 260,
        contentWidth: 420,
        initialWidth: 180,
      }),
    ).toBe(260);
  });

  it("shrinks to a container narrower than its normal minimum", () => {
    expect(
      profileNameEditorWidth({
        availableWidth: 120,
        contentWidth: 420,
        initialWidth: 180,
      }),
    ).toBe(120);
  });
});

describe("shouldSubmitProfileNameEnter", () => {
  const ordinaryEnter = {
    compositionActive: false,
    key: "Enter",
    keyCode: 13,
    nativeIsComposing: false,
  };

  it("submits an ordinary Enter", () => {
    expect(shouldSubmitProfileNameEnter(ordinaryEnter)).toBe(true);
  });

  it.each([
    ["active React composition", { ...ordinaryEnter, compositionActive: true }],
    ["native composition", { ...ordinaryEnter, nativeIsComposing: true }],
    ["legacy IME key code", { ...ordinaryEnter, keyCode: 229 }],
    ["a different key", { ...ordinaryEnter, key: "Escape", keyCode: 27 }],
  ])("does not submit for %s", (_label, input) => {
    expect(shouldSubmitProfileNameEnter(input)).toBe(false);
  });
});
