import { describe, expect, it } from "vitest";

import {
  SignatureError,
  verifyEncryptedSignature,
  verifyPlaintextSignature,
  wechatSignature,
} from "./signature.js";

const now = new Date(1_700_000_000_000);

describe("WeChat callback signatures", () => {
  it("matches the lexicographically sorted SHA-1 protocol", () => {
    expect(wechatSignature(["token", "1700000000", "nonce"]))
      .toBe("bf37e74fc61ce5974ce58c68e55130b79b2578b9");
  });

  it("accepts valid plaintext and encrypted signatures", () => {
    expect(() => verifyPlaintextSignature({
      maxSkewSeconds: 300,
      nonce: "nonce",
      now,
      signature: "bf37e74fc61ce5974ce58c68e55130b79b2578b9",
      timestamp: "1700000000",
      token: "token",
    })).not.toThrow();
    const encrypted = "ciphertext";
    expect(() => verifyEncryptedSignature({
      encrypted,
      maxSkewSeconds: 300,
      nonce: "nonce",
      now,
      signature: wechatSignature(["token", "1700000000", "nonce", encrypted]),
      timestamp: "1700000000",
      token: "token",
    })).not.toThrow();
  });

  it("rejects stale, malformed and mismatched requests", () => {
    expect(() => verifyPlaintextSignature({
      maxSkewSeconds: 60,
      nonce: "nonce",
      now,
      signature: "bf37e74fc61ce5974ce58c68e55130b79b2578b9",
      timestamp: "1699999000",
      token: "token",
    })).toThrowError(new SignatureError("stale_timestamp"));
    expect(() => verifyPlaintextSignature({
      maxSkewSeconds: 300,
      nonce: "bad nonce",
      now,
      signature: "c5cf601a2124d143e499423144c189a270f7b3ae",
      timestamp: "1700000000",
      token: "token",
    })).toThrowError(new SignatureError("invalid_nonce"));
    expect(() => verifyEncryptedSignature({
      encrypted: "ciphertext",
      maxSkewSeconds: 300,
      nonce: "nonce",
      now,
      signature: "0".repeat(40),
      timestamp: "1700000000",
      token: "token",
    })).toThrowError(new SignatureError("invalid_signature"));
  });
});
