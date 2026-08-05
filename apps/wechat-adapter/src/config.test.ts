import { describe, expect, it } from "vitest";

import { loadWechatAdapterConfig } from "./config.js";

const validEnv: NodeJS.ProcessEnv = {
  ATTENTION_CHANNEL_ADAPTER_SECRET: "i".repeat(32),
  ATTENTION_CHANNEL_API_BASE_URL: "http://127.0.0.1:3000/",
  WECHAT_APP_ID: "wx1234567890abcdef",
  WECHAT_APP_SECRET: "wechat-app-secret",
  WECHAT_CALLBACK_TOKEN: "callback-token",
  WECHAT_ENCODING_AES_KEY: Buffer.alloc(32, 7).toString("base64").slice(0, 43),
};

describe("WeChat adapter startup config", () => {
  it("validates credentials and applies safe defaults", () => {
    expect(loadWechatAdapterConfig(validEnv)).toMatchObject({
      asyncReplyProvider: "disabled",
      attentionApiBaseUrl: "http://127.0.0.1:3000",
      callbackPath: "/wechat/callback",
      messageMode: "compatible",
      port: 4200,
    });
  });

  it("allows only the fixed same-stack Web service over HTTP", () => {
    expect(loadWechatAdapterConfig({
      ...validEnv,
      ATTENTION_CHANNEL_API_BASE_URL: "http://web:3000",
    }).attentionApiBaseUrl).toBe("http://web:3000");
    expect(() => loadWechatAdapterConfig({
      ...validEnv,
      ATTENTION_CHANNEL_API_BASE_URL: "http://other-service:3000",
    })).toThrow(/HTTPS/u);
  });

  it.each([
    { ...validEnv, WECHAT_APP_SECRET: undefined },
    { ...validEnv, WECHAT_ENCODING_AES_KEY: "too-short" },
    { ...validEnv, ATTENTION_CHANNEL_ADAPTER_SECRET: "short" },
    { ...validEnv, ATTENTION_CHANNEL_API_BASE_URL: "file:///tmp/socket" },
    { ...validEnv, ATTENTION_CHANNEL_API_BASE_URL: "http://attention.example/api" },
    { ...validEnv, ATTENTION_CHANNEL_API_BASE_URL: "https://attention.example/api?token=unsafe" },
    { ...validEnv, WECHAT_API_BASE_URL: "http://api.weixin.qq.com" },
    { ...validEnv, WECHAT_API_BASE_URL: "https://user:password@api.weixin.qq.com" },
  ])("refuses to start with missing or malformed credentials", (env) => {
    expect(() => loadWechatAdapterConfig(env)).toThrow();
  });
});
