import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const component = readFileSync(
  new URL("./profile-identity-editor.tsx", import.meta.url),
  "utf8",
);
const styles = readFileSync(
  new URL("../app/globals.css", import.meta.url),
  "utf8",
);

describe("ProfileIdentityEditor display-name wiring", () => {
  it("measures the draft against the live profile container", () => {
    expect(component).toContain("profileNameEditorWidth");
    expect(component).toContain("new ResizeObserver");
    expect(component).toContain("profile-name-editor__measure");
    expect(component).toContain("profileCopyRef");
    expect(component).toContain("nameMeasureRef");
    expect(component).toContain("nameActionsRef");
  });

  it("guards Enter while an IME composition is active", () => {
    expect(component).toContain("shouldSubmitProfileNameEnter");
    expect(component).toContain("onCompositionStart");
    expect(component).toContain("onCompositionEnd");
    expect(component).not.toContain('if (event.key === "Enter")');
  });

  it("uses an unwrapped probe while preserving wrapped textarea height", () => {
    expect(styles).toMatch(
      /\.profile-name-editor__measure\s*\{[\s\S]*?white-space:\s*pre;/u,
    );
    expect(styles).toMatch(
      /\.profile-name-editor__mirror,[\s\S]*?white-space:\s*pre-wrap;/u,
    );
    expect(styles).toContain("overflow-wrap: anywhere");
  });
});
