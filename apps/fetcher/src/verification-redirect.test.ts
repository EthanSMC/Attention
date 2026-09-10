import { describe, expect, it } from "vitest";
import { isWechatVerificationRedirect } from "./verification-redirect.js";

const from = new URL("https://mp.weixin.qq.com/s/example");
const challenge = "https://mp.weixin.qq.com/mp/wappoc_appmsgcaptcha?poc_token=synthetic&target_url=synthetic";

describe("WeChat verification redirect classification", () => {
  it("recognizes the observed same-origin challenge without permitting a fetch", () => {
    expect(isWechatVerificationRedirect(from, new URL(challenge))).toBe(true);
  });
  it.each([
    challenge.replace("https:", "http:"),
    challenge.replace("mp.weixin.qq.com/", "mp.weixin.qq.com.evil.test/"),
    challenge.replace("mp.weixin.qq.com/", "127.0.0.1/"),
    challenge.replace("mp.weixin.qq.com/", "user:secret@mp.weixin.qq.com/"),
    challenge.replace("mp.weixin.qq.com/", "mp.weixin.qq.com:8080/"),
    challenge + "&access_token=synthetic",
    challenge + "&poc_token=duplicate",
    challenge + "#token=synthetic",
    challenge.replace("wappoc_appmsgcaptcha", "other"),
  ])("does not classify an unrecognized target as the official challenge: %s", target => {
    expect(isWechatVerificationRedirect(from, new URL(target))).toBe(false);
  });
});
