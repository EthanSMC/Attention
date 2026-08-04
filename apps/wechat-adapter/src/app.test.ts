import { describe, expect, it, vi } from "vitest";

import type { AttentionChannelGateway } from "./attention-client.js";
import { createWechatApp } from "./app.js";
import { MessageDeliveryCoordinator } from "./delivery.js";
import { decryptWechatMessage, encryptWechatMessage } from "./message-crypto.js";
import { wechatSignature } from "./signature.js";
import type {
  ChannelGatewayReply,
  NormalizedWechatMessage,
  SafeLogger,
  WechatAdapterConfig,
} from "./types.js";
import { parseWechatXml, serializeWechatXml } from "./xml.js";

const timestamp = "1700000000";
const nonce = "nonce-1";
const now = new Date(1_700_000_000_000);
const config: WechatAdapterConfig = {
  appId: "wx1234567890abcdef",
  appSecret: "wechat-app-secret",
  asyncReplyProvider: "disabled",
  attentionApiBaseUrl: "http://127.0.0.1:3000",
  attentionApiSecret: "i".repeat(32),
  callbackPath: "/wechat/callback",
  callbackToken: "callback-token",
  encodingAesKey: Buffer.alloc(32, 7).toString("base64").slice(0, 43),
  host: "127.0.0.1",
  maxBodyBytes: 65_536,
  maxTimestampSkewSeconds: 300,
  messageMode: "compatible",
  originalId: "gh_attention",
  pendingPollIntervalMs: 2_000,
  pendingPollTimeoutMs: 600_000,
  port: 4200,
  syncTimeoutMs: 3_500,
  wechatApiBaseUrl: "https://api.weixin.qq.com",
};
const logger: SafeLogger = {
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
};

function messageXml(fields: Record<string, string> = {}): string {
  return serializeWechatXml({
    Content: "收藏 https://example.com/post",
    CreateTime: timestamp,
    FromUserName: "openid-sensitive",
    MsgId: "123456789",
    MsgType: "text",
    ToUserName: "gh_attention",
    ...fields,
  });
}

function plainQuery(signature = wechatSignature([config.callbackToken, timestamp, nonce])): string {
  return new URLSearchParams({ nonce, signature, timestamp }).toString();
}

function safeQuery(ciphertext: string): string {
  return new URLSearchParams({
    encrypt_type: "aes",
    msg_signature: wechatSignature([config.callbackToken, timestamp, nonce, ciphertext]),
    nonce,
    timestamp,
  }).toString();
}

function completedDelivery(text = "done"): {
  deliver(message: NormalizedWechatMessage): Promise<{ text: string; timedOut: boolean }>;
} {
  return { deliver: vi.fn(async () => ({ text, timedOut: false })) };
}

describe("WeChat callback application", () => {
  it("handles plaintext GET server verification", async () => {
    const app = createWechatApp(config, { delivery: completedDelivery(), logger, now: () => now });
    const valid = await app.request(
      `${config.callbackPath}?${plainQuery()}&echostr=verified`,
    );
    expect(valid.status).toBe(200);
    await expect(valid.text()).resolves.toBe("verified");
    const invalid = await app.request(
      `${config.callbackPath}?${plainQuery("0".repeat(40))}&echostr=verified`,
    );
    expect(invalid.status).toBe(403);
  });

  it("handles encrypted GET server verification", async () => {
    const echo = encryptWechatMessage({
      appId: config.appId,
      encodingAesKey: config.encodingAesKey,
      message: "verified-safe",
      randomBytesImplementation: () => Buffer.alloc(16, 4),
    });
    const app = createWechatApp(config, { delivery: completedDelivery(), logger, now: () => now });
    const query = new URLSearchParams(`${safeQuery(echo)}&echostr=${encodeURIComponent(echo)}`);
    const response = await app.request(`${config.callbackPath}?${query.toString()}`);
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("verified-safe");
  });

  it("normalizes plaintext callbacks and produces a passive text reply", async () => {
    const delivery = completedDelivery("collected");
    const app = createWechatApp(config, { delivery, logger, now: () => now });
    const response = await app.request(`${config.callbackPath}?${plainQuery()}`, {
      body: messageXml(),
      headers: { "content-type": "text/xml" },
      method: "POST",
    });
    expect(response.status).toBe(200);
    const fields = parseWechatXml(await response.text());
    expect(fields).toMatchObject({
      Content: "collected",
      FromUserName: "gh_attention",
      ToUserName: "openid-sensitive",
    });
    expect(delivery.deliver).toHaveBeenCalledWith(expect.objectContaining({
      action: "collect",
      channelMessageId: "msg:123456789:1700000000",
    }));
  });

  it("decrypts safe-mode callbacks and encrypts the passive reply", async () => {
    const clear = messageXml({ Content: "我的收藏有哪些？" });
    const ciphertext = encryptWechatMessage({
      appId: config.appId,
      encodingAesKey: config.encodingAesKey,
      message: clear,
      randomBytesImplementation: () => Buffer.alloc(16, 5),
    });
    const app = createWechatApp(config, {
      delivery: completedDelivery("answer-safe"),
      logger,
      now: () => now,
    });
    const response = await app.request(`${config.callbackPath}?${safeQuery(ciphertext)}`, {
      body: serializeWechatXml({ Encrypt: ciphertext }),
      headers: { "content-type": "application/xml" },
      method: "POST",
    });
    expect(response.status).toBe(200);
    const outer = parseWechatXml(await response.text());
    const reply = decryptWechatMessage({
      appId: config.appId,
      ciphertext: outer.Encrypt ?? "",
      encodingAesKey: config.encodingAesKey,
    });
    expect(parseWechatXml(reply)).toMatchObject({
      Content: "answer-safe",
      ToUserName: "openid-sensitive",
    });
  });

  it("returns success for unsupported event messages and rejects unsafe XML", async () => {
    const delivery = completedDelivery();
    const app = createWechatApp(config, { delivery, logger, now: () => now });
    const unsupported = await app.request(`${config.callbackPath}?${plainQuery()}`, {
      body: messageXml({ Content: "", Event: "subscribe", MsgType: "event" }),
      headers: { "content-type": "text/xml" },
      method: "POST",
    });
    expect(unsupported.status).toBe(200);
    await expect(unsupported.text()).resolves.toBe("success");
    const unsafe = await app.request(`${config.callbackPath}?${plainQuery()}`, {
      body: "<!DOCTYPE xml [<!ENTITY x SYSTEM 'file:///etc/passwd'>]><xml><A>&x;</A></xml>",
      headers: { "content-type": "text/xml" },
      method: "POST",
    });
    expect(unsafe.status).toBe(400);
    expect(delivery.deliver).not.toHaveBeenCalled();
  });

  it("stops reading an oversized chunked callback before signature handling", async () => {
    let cancelled = false;
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
      pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(new Uint8Array(config.maxBodyBytes + 1));
          return;
        }
        controller.error(new Error("oversized callback was read after cancellation"));
      },
    });
    const app = createWechatApp(config, {
      delivery: completedDelivery(),
      logger,
      now: () => now,
    });
    const request = new Request(
      `http://localhost${config.callbackPath}?${plainQuery()}`,
      {
        body,
        duplex: "half",
        headers: { "content-type": "text/xml" },
        method: "POST",
      } as RequestInit & { duplex: "half" },
    );

    const response = await app.fetch(request);

    expect(response.status).toBe(413);
    await expect(response.text()).resolves.toBe("payload_too_large");
    expect(cancelled).toBe(true);
    expect(pulls).toBe(1);
  });

  it("coalesces callback retries and degrades internal API errors safely", async () => {
    const send = vi.fn(async (): Promise<ChannelGatewayReply> => ({
      pendingRequestId: null,
      status: "completed",
      text: "done",
    }));
    const gateway: AttentionChannelGateway = { pollPending: vi.fn(), send };
    const coordinator = new MessageDeliveryCoordinator(gateway, {
      asyncSender: null,
      logger,
      syncTimeoutMs: 100,
    });
    const app = createWechatApp(config, { delivery: coordinator, logger, now: () => now });
    for (let index = 0; index < 2; index += 1) {
      const response = await app.request(`${config.callbackPath}?${plainQuery()}`, {
        body: messageXml(),
        headers: { "content-type": "text/xml" },
        method: "POST",
      });
      expect(response.status).toBe(200);
    }
    expect(send).toHaveBeenCalledTimes(1);

    const failingGateway: AttentionChannelGateway = {
      pollPending: vi.fn(),
      send: vi.fn(async () => { throw new Error("internal-secret-sensitive openid-sensitive"); }),
    };
    const failingApp = createWechatApp(config, {
      delivery: new MessageDeliveryCoordinator(failingGateway, {
        asyncSender: null,
        logger,
        syncTimeoutMs: 100,
      }),
      logger,
      now: () => now,
    });
    const failed = await failingApp.request(`${config.callbackPath}?${plainQuery()}`, {
      body: messageXml(),
      headers: { "content-type": "text/xml" },
      method: "POST",
    });
    expect(failed.status).toBe(200);
    const body = await failed.text();
    expect(body).toContain("暂时无法处理");
    expect(body).not.toContain("internal-secret-sensitive");
  });
});
