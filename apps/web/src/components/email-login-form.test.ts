import { describe, expect, it } from "vitest";

import { forgotPasswordHref } from "./email-login-form";

describe("forgotPasswordHref", () => {
  it("preserves the protected task that opened the login module", () => {
    expect(forgotPasswordHref("/collect")).toBe(
      "/login?return_to=%2Fcollect",
    );
    expect(forgotPasswordHref("/oauth/authorize?client_id=client-1")).toBe(
      "/login?return_to=%2Foauth%2Fauthorize%3Fclient_id%3Dclient-1",
    );
  });
});
