import { describe, expect, it } from "vitest";

import {
  channelSessionFingerprint,
  opaqueRuntimeFingerprint,
} from "./runtime-identity";

describe("Runtime channel identity", () => {
  it("derives a domain-separated fingerprint without exposing the iLink token", () => {
    const token = "local-bot-token";
    const fingerprint = channelSessionFingerprint(token);

    expect(fingerprint).toBe(
      "f51d124e455d764eb72a0219127eca76b94b7be3c1c48441f0e7c9ba48e68694",
    );
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(fingerprint).not.toBe(
      opaqueRuntimeFingerprint("wechat_ilink", token),
    );
    expect(fingerprint).not.toContain(token);
  });

  it("refuses to derive ownership from an absent iLink session", () => {
    expect(() => channelSessionFingerprint("")).toThrow(
      "ilink_session_missing",
    );
  });
});
