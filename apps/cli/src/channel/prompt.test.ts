import { describe, expect, it } from "vitest";

import { buildFirstTurnPrompt } from "./prompt";

describe("channel intent", () => {
  it("uses the authenticated account role for the new-collection default", () => {
    const prompt = buildFirstTurnPrompt({
      messageRef: "msg-1",
      userMessage: "https://example.com/article",
    });

    expect(prompt).toContain("attention_get_my_account");
    expect(prompt).toContain("Filter");
    expect(prompt).toContain("默认 public");
    expect(prompt).toContain("Member");
    expect(prompt).toContain("默认 private");
    expect(prompt).not.toContain("visibility 默认 private");
  });
});
