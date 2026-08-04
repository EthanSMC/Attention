import { afterEach, describe, expect, it, vi } from "vitest";

import { safeLogger } from "./logger.js";

afterEach(() => vi.restoreAllMocks());

describe("safe logger", () => {
  it("drops non-whitelisted fields instead of logging credentials or identities", () => {
    const output = vi.spyOn(console, "info").mockImplementation(() => undefined);
    safeLogger.info("wechat_adapter_started", {
      host: "127.0.0.1",
      openid: "openid-sensitive",
      port: 4200,
      secret: "app-secret-sensitive",
    });
    const line = String(output.mock.calls[0]?.[0]);
    expect(line).toContain("wechat_adapter_started");
    expect(line).toContain("4200");
    expect(line).not.toContain("openid");
    expect(line).not.toContain("secret");
  });
});
