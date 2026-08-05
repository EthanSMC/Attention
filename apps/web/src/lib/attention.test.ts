import { describe, expect, it } from "vitest";

import {
  accountIdentityLabel,
  publicCollectorLabel,
} from "./attention";

describe("public identity labels", () => {
  it("labels an account with its display name and public Attention ID", () => {
    expect(
      accountIdentityLabel({
        attentionId: "linmo",
        displayName: "林墨",
        primaryEmail: "linmo@example.com",
      }),
    ).toBe("林墨 (@linmo)");
  });

  it("falls back safely when an account has no Attention ID", () => {
    expect(
      accountIdentityLabel({
        attentionId: null,
        displayName: "林墨",
        primaryEmail: "linmo@example.com",
      }),
    ).toBe("林墨");
    expect(
      accountIdentityLabel({
        attentionId: null,
        displayName: " ",
        primaryEmail: "linmo@example.com",
      }),
    ).toBe("linmo@example.com");
  });

  it("uses a collector's display name only when its Attention ID is null", () => {
    expect(
      publicCollectorLabel({ attentionId: "linmo", displayName: "林墨" }),
    ).toBe("@linmo");
    expect(
      publicCollectorLabel({ attentionId: null, displayName: "林墨" }),
    ).toBe("林墨");
  });
});
