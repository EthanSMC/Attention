import { describe, expect, it } from "vitest";

import {
  decryptWechatMessage,
  encryptedReplyXml,
  encryptWechatMessage,
  WechatCryptoError,
} from "./message-crypto.js";
import { verifyEncryptedSignature } from "./signature.js";
import { parseWechatXml } from "./xml.js";

const appId = "wx1234567890abcdef";
const encodingAesKey = Buffer.alloc(32, 7).toString("base64").slice(0, 43);

describe("WeChat AES messages", () => {
  it("round-trips the official random + length + XML + app-id envelope", () => {
    const message = "<xml><Content><![CDATA[你好<&]]></Content></xml>";
    const encrypted = encryptWechatMessage({
      appId,
      encodingAesKey,
      message,
      randomBytesImplementation: () => Buffer.alloc(16, 9),
    });
    expect(decryptWechatMessage({ appId, ciphertext: encrypted, encodingAesKey })).toBe(message);
  });

  it("rejects an app-id mismatch and tampered ciphertext", () => {
    const encrypted = encryptWechatMessage({
      appId,
      encodingAesKey,
      message: "hello",
      randomBytesImplementation: () => Buffer.alloc(16, 1),
    });
    expect(() => decryptWechatMessage({
      appId: "wxabcdef1234567890",
      ciphertext: encrypted,
      encodingAesKey,
    })).toThrowError(new WechatCryptoError("app_id_mismatch"));
    expect(() => decryptWechatMessage({
      appId,
      ciphertext: `${encrypted.slice(0, -4)}AAAA`,
      encodingAesKey,
    })).toThrow(WechatCryptoError);
  });

  it("wraps encrypted passive replies with a verifiable message signature", () => {
    const xml = encryptedReplyXml({
      appId,
      encodingAesKey,
      message: "<xml><Content><![CDATA[done]]></Content></xml>",
      nonce: "nonce",
      timestamp: 1_700_000_000,
      token: "token",
    });
    const fields = parseWechatXml(xml);
    verifyEncryptedSignature({
      encrypted: fields.Encrypt ?? "",
      maxSkewSeconds: 300,
      nonce: fields.Nonce ?? "",
      now: new Date(1_700_000_000_000),
      signature: fields.MsgSignature ?? "",
      timestamp: fields.TimeStamp ?? "",
      token: "token",
    });
    expect(decryptWechatMessage({
      appId,
      ciphertext: fields.Encrypt ?? "",
      encodingAesKey,
    })).toContain("done");
  });
});
