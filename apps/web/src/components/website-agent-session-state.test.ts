import { describe, expect, it } from "vitest";

import { canApplyWebsiteSessionUpdate, websiteSessionIdToLoad } from "./website-agent-session-state";

const current = { generation: 1, currentGeneration: 1, aborted: false, expectedSessionId: "owned-session", actualSessionId: "owned-session", previousRevision: 3, incomingRevision: 4 };
describe("website session polling state", () => {
  it("accepts an equal/newer revision for the same active interaction", () => {
    expect(canApplyWebsiteSessionUpdate(current)).toBe(true);
    expect(canApplyWebsiteSessionUpdate({ ...current, incomingRevision: 3 })).toBe(true);
  });
  it.each([{ incomingRevision: 2 }, { currentGeneration: 2 }, { aborted: true }, { actualSessionId: "other-session" }, { incomingRevision: NaN }])("ignores old, cancelled and cross-session responses: %s", change => {
      expect(canApplyWebsiteSessionUpdate({ ...current, ...change })).toBe(false);
    });
  it("loads an explicit older deep link even if it is outside the newest list page", () => {
    expect(websiteSessionIdToLoad("older-owned-session", [{ id: "newer-session", status: "open" }])).toBe("older-owned-session");
    expect(websiteSessionIdToLoad("guessed-session", [])).toBe("guessed-session");
    expect(websiteSessionIdToLoad(null, [{ id: "newer-session", status: "open" }])).toBe("newer-session");
  });
});
