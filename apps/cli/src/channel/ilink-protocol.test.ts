import { describe, expect, it } from "vitest";

import {
  buildIlinkHeaders,
  isSessionExpired,
  apiOk,
  ILinkSessionExpiredError,
  randomWechatUin,
  validateIlinkBaseUrl,
} from "./ilink-protocol";

describe("iLink protocol helpers", () => {
  it("treats ret and errcode zero as success", () => {
    expect(apiOk({})).toBe(true);
    expect(apiOk({ errcode: 0, ret: 0 })).toBe(true);
    expect(apiOk({ errcode: 0, ret: 1 })).toBe(false);
    expect(apiOk({ errcode: -14, ret: 0 })).toBe(false);
  });

  it("detects session expiry errcode", () => {
    expect(isSessionExpired({ errcode: -14 })).toBe(true);
    expect(isSessionExpired({ errcode: 0 })).toBe(false);
    expect(isSessionExpired({})).toBe(false);
  });

  it("names the session expiry error", () => {
    expect(new ILinkSessionExpiredError().name).toBe(
      "ILinkSessionExpiredError",
    );
  });

  it("builds headers with base64 UIN and optional bearer token", () => {
    const anonymous = buildIlinkHeaders({ randomUin: () => "12345" });
    expect(anonymous).toMatchObject({
      AuthorizationType: "ilink_bot_token",
      "Content-Type": "application/json",
      "X-WECHAT-UIN": Buffer.from("12345", "utf8").toString("base64"),
    });
    expect(anonymous.Authorization).toBeUndefined();

    const authenticated = buildIlinkHeaders({
      randomUin: () => "1",
      token: "token-value",
    });
    expect(authenticated.Authorization).toBe("Bearer token-value");
  });

  it("derives decimal UIN strings", () => {
    const uin = randomWechatUin(() => 42);
    expect(uin).toBe("42");
    expect(randomWechatUin()).toMatch(/^\d+$/u);
  });

  it("accepts only HTTPS endpoints owned by the official WeChat domain", () => {
    expect(validateIlinkBaseUrl("https://ilinkai.weixin.qq.com/")).toBe(
      "https://ilinkai.weixin.qq.com",
    );
    expect(validateIlinkBaseUrl("https://edge.weixin.qq.com/base")).toBe(
      "https://edge.weixin.qq.com/base",
    );
    expect(() => validateIlinkBaseUrl("http://ilinkai.weixin.qq.com")).toThrow(
      /official WeChat/u,
    );
    expect(() => validateIlinkBaseUrl("https://weixin.qq.com.evil.example")).toThrow(
      /official WeChat/u,
    );
  });
});
