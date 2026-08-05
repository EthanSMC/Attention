import { z } from "zod";

import type { WechatAdapterConfig } from "./types.js";

const schema = z.object({
  ATTENTION_CHANNEL_ADAPTER_SECRET: z.string().min(32),
  ATTENTION_CHANNEL_API_BASE_URL: z.string().url(),
  WECHAT_ADAPTER_HOST: z.string().min(1).default("127.0.0.1"),
  WECHAT_ADAPTER_PORT: z.coerce.number().int().min(1).max(65_535).default(4200),
  WECHAT_API_BASE_URL: z.string().url().default("https://api.weixin.qq.com"),
  WECHAT_APP_ID: z.string().regex(/^wx[a-f0-9]{16}$/iu),
  WECHAT_APP_SECRET: z.string().min(16),
  WECHAT_ASYNC_REPLY_PROVIDER: z.enum(["customer_service", "disabled"]).default("disabled"),
  WECHAT_CALLBACK_PATH: z.string().regex(/^\/[A-Za-z0-9/_-]*$/u).default("/wechat/callback"),
  WECHAT_CALLBACK_TOKEN: z.string().min(3).max(128),
  WECHAT_ENCODING_AES_KEY: z.string().regex(/^[A-Za-z0-9+/]{43}$/u),
  WECHAT_MAX_BODY_BYTES: z.coerce.number().int().min(1_024).max(262_144).default(65_536),
  WECHAT_MAX_TIMESTAMP_SKEW_SECONDS: z.coerce.number().int().min(30).max(3_600).default(300),
  WECHAT_MESSAGE_MODE: z.enum(["compatible", "plaintext", "safe"]).default("compatible"),
  WECHAT_ORIGINAL_ID: z.string().min(1).max(128).optional(),
  WECHAT_PENDING_POLL_INTERVAL_MS: z.coerce.number().int().min(250).max(10_000).default(2_000),
  WECHAT_PENDING_POLL_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(600_000),
  WECHAT_SYNC_TIMEOUT_MS: z.coerce.number().int().min(250).max(4_500).default(3_500),
});

function normalizedBaseUrl(
  value: string,
  name: string,
  options: { allowedInsecureHosts?: readonly string[] } = {},
): string {
  const url = new URL(value);
  const loopback = url.hostname === "127.0.0.1" ||
    url.hostname === "localhost" ||
    url.hostname === "[::1]";
  const explicitlyAllowed = options.allowedInsecureHosts?.includes(url.hostname) ?? false;
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && (loopback || explicitlyAllowed)))
  ) {
    throw new Error(`${name} must use HTTPS without credentials, query or fragment (HTTP is loopback-only)`);
  }
  return url.toString().replace(/\/+$/u, "");
}

export function loadWechatAdapterConfig(
  env: NodeJS.ProcessEnv = process.env,
): WechatAdapterConfig {
  const parsed = schema.parse(env);
  const aesKey = Buffer.from(`${parsed.WECHAT_ENCODING_AES_KEY}=`, "base64");
  if (aesKey.length !== 32) throw new Error("WECHAT_ENCODING_AES_KEY must decode to 32 bytes");
  return {
    appId: parsed.WECHAT_APP_ID,
    appSecret: parsed.WECHAT_APP_SECRET,
    asyncReplyProvider: parsed.WECHAT_ASYNC_REPLY_PROVIDER,
    attentionApiBaseUrl: normalizedBaseUrl(
      parsed.ATTENTION_CHANNEL_API_BASE_URL,
      "ATTENTION_CHANNEL_API_BASE_URL",
      { allowedInsecureHosts: ["web"] },
    ),
    attentionApiSecret: parsed.ATTENTION_CHANNEL_ADAPTER_SECRET,
    callbackPath: parsed.WECHAT_CALLBACK_PATH,
    callbackToken: parsed.WECHAT_CALLBACK_TOKEN,
    encodingAesKey: parsed.WECHAT_ENCODING_AES_KEY,
    host: parsed.WECHAT_ADAPTER_HOST,
    maxBodyBytes: parsed.WECHAT_MAX_BODY_BYTES,
    maxTimestampSkewSeconds: parsed.WECHAT_MAX_TIMESTAMP_SKEW_SECONDS,
    messageMode: parsed.WECHAT_MESSAGE_MODE,
    originalId: parsed.WECHAT_ORIGINAL_ID ?? null,
    pendingPollIntervalMs: parsed.WECHAT_PENDING_POLL_INTERVAL_MS,
    pendingPollTimeoutMs: parsed.WECHAT_PENDING_POLL_TIMEOUT_MS,
    port: parsed.WECHAT_ADAPTER_PORT,
    syncTimeoutMs: parsed.WECHAT_SYNC_TIMEOUT_MS,
    wechatApiBaseUrl: normalizedBaseUrl(parsed.WECHAT_API_BASE_URL, "WECHAT_API_BASE_URL"),
  };
}
