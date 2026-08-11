import { describe, expect, it, vi } from "vitest";

import { revealActiveDocumentLink } from "./agent-doc-navigation";

describe("revealActiveDocumentLink", () => {
  it("centers the active mobile document without moving the page vertically", () => {
    const scrollIntoView = vi.fn();

    revealActiveDocumentLink({ scrollIntoView });

    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "instant",
      block: "nearest",
      inline: "center",
    });
  });
});
