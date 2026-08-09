import { describe, expect, it } from "vitest";

import { ILinkClient } from "./ilink-client";
import { ILinkSessionExpiredError } from "./ilink-protocol";

interface RecordedRequest {
  readonly body: unknown;
  readonly headers: Record<string, string>;
  readonly method: string;
  readonly url: string;
}

function fakeFetch(
  responder: (request: RecordedRequest) => {
    readonly body: string;
    readonly status?: number;
  },
): { calls: RecordedRequest[]; fetchImpl: typeof fetch } {
  const calls: RecordedRequest[] = [];
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const request: RecordedRequest = {
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
      method: init?.method ?? "GET",
      url: String(input),
    };
    calls.push(request);
    const { body, status = 200 } = responder(request);
    return new Response(body, { status });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("ILinkClient", () => {
  it("requests a QR code and validates the payload", async () => {
    const { calls, fetchImpl } = fakeFetch(() => ({
      body: JSON.stringify({
        errcode: 0,
        qrcode: "qr-1",
        qrcode_img_content: "https://qr.example/payload",
        ret: 0,
      }),
    }));
    const client = new ILinkClient({ fetchImpl, timeoutMs: 1000 });
    const qr = await client.requestQrCode();
    expect(qr).toEqual({
      qrcodeId: "qr-1",
      qrPayload: "https://qr.example/payload",
    });
    expect(calls[0]?.url).toContain("ilink/bot/get_bot_qrcode");
    expect(calls[0]?.url).toContain("bot_type=3");
    expect(calls[0]?.headers.Authorization).toBeUndefined();
  });

  it("rejects an empty QR response", async () => {
    const { fetchImpl } = fakeFetch(() => ({ body: JSON.stringify({}) }));
    const client = new ILinkClient({ fetchImpl, timeoutMs: 1000 });
    await expect(client.requestQrCode()).rejects.toThrow(/QR response/u);
  });

  it("maps confirmed QR status including base url switch", async () => {
    const { calls, fetchImpl } = fakeFetch(() => ({
      body: JSON.stringify({
        baseurl: "https://alt.weixin.qq.com/",
        bot_token: "token-1",
        errcode: 0,
        ilink_bot_id: "bot-1",
        ret: 0,
        status: "confirmed",
      }),
    }));
    const client = new ILinkClient({ fetchImpl, timeoutMs: 1000 });
    const status = await client.pollQrStatus("qr-1");
    expect(status).toEqual({
      baseUrl: "https://alt.weixin.qq.com",
      botToken: "token-1",
      ilinkBotId: "bot-1",
      status: "confirmed",
    });
    expect(calls[0]?.headers["iLink-App-ClientVersion"]).toBe("1");
  });

  it("requires bot_token on confirmation", async () => {
    const { fetchImpl } = fakeFetch(() => ({
      body: JSON.stringify({ errcode: 0, ret: 0, status: "confirmed" }),
    }));
    const client = new ILinkClient({ fetchImpl, timeoutMs: 1000 });
    await expect(client.pollQrStatus("qr-1")).rejects.toThrow(/bot_token/u);
  });

  it("rejects an untrusted base URL returned with a QR confirmation", async () => {
    const { fetchImpl } = fakeFetch(() => ({
      body: JSON.stringify({
        baseurl: "https://credential-stealer.example",
        bot_token: "token-1",
        status: "confirmed",
      }),
    }));
    const client = new ILinkClient({ fetchImpl, timeoutMs: 1000 });
    await expect(client.pollQrStatus("qr-1")).rejects.toThrow(
      /official WeChat/u,
    );
  });

  it("maps wait and expired statuses", async () => {
    const responses = [
      JSON.stringify({ status: "wait" }),
      JSON.stringify({ status: "expired" }),
    ];
    let index = 0;
    const { fetchImpl } = fakeFetch(() => ({ body: responses[index++] ?? "" }));
    const client = new ILinkClient({ fetchImpl, timeoutMs: 1000 });
    expect((await client.pollQrStatus("qr")).status).toBe("wait");
    expect((await client.pollQrStatus("qr")).status).toBe("expired");
  });

  it("parses getupdates messages and cursor", async () => {
    const { calls, fetchImpl } = fakeFetch(() => ({
      body: JSON.stringify({
        errcode: 0,
        get_updates_buf: "cursor-2",
        msgs: [
          {
            context_token: "ctx-1",
            from_user_id: "owner",
            item_list: [{ text_item: { text: "hi" }, type: 1 }],
          },
          { malformed: true },
        ],
        ret: 0,
      }),
    }));
    const client = new ILinkClient({ fetchImpl, timeoutMs: 1000 });
    client.token = "token-1";
    const updates = await client.getUpdates("cursor-1");
    expect(updates.syncBuf).toBe("cursor-2");
    expect(updates.messages).toHaveLength(1);
    expect(updates.messages[0]?.fromUserId).toBe("owner");
    expect(calls[0]?.headers.Authorization).toBe("Bearer token-1");
    expect(calls[0]?.body).toMatchObject({
      base_info: { channel_version: "ilink-mini-bot" },
      get_updates_buf: "cursor-1",
    });
  });

  it("throws the session-expired error on errcode -14", async () => {
    const { fetchImpl } = fakeFetch(() => ({
      body: JSON.stringify({ errcode: -14, errmsg: "session timeout", ret: 0 }),
    }));
    const client = new ILinkClient({ fetchImpl, timeoutMs: 1000 });
    client.token = "token-1";
    await expect(client.getUpdates("")).rejects.toBeInstanceOf(
      ILinkSessionExpiredError,
    );
  });

  it("raises on non-ok getupdates responses", async () => {
    const { fetchImpl } = fakeFetch(() => ({
      body: JSON.stringify({ errcode: 500, errmsg: "boom", ret: -1 }),
    }));
    const client = new ILinkClient({ fetchImpl, timeoutMs: 1000 });
    client.token = "token-1";
    await expect(client.getUpdates("")).rejects.toThrow(/getupdates failed/u);
  });

  it("sends text messages with context token", async () => {
    const { calls, fetchImpl } = fakeFetch(() => ({
      body: JSON.stringify({ errcode: 0, ret: 0 }),
    }));
    const client = new ILinkClient({ fetchImpl, timeoutMs: 1000 });
    client.token = "token-1";
    const ok = await client.sendMessage({
      clientId: "reply-message-9",
      contextToken: "ctx-9",
      text: "已收藏",
      toUserId: "owner",
    });
    expect(ok).toBe(true);
    const body = calls[0]?.body as {
      msg: { context_token: string; item_list: unknown[]; to_user_id: string };
    };
    expect(body.msg.to_user_id).toBe("owner");
    expect((body.msg as { client_id?: string }).client_id).toBe(
      "reply-message-9",
    );
    expect(body.msg.context_token).toBe("ctx-9");
    expect(body.msg.item_list).toEqual([
      { text_item: { text: "已收藏" }, type: 1 },
    ]);
  });

  it("reports send failure through apiOk", async () => {
    const { fetchImpl } = fakeFetch(() => ({
      body: JSON.stringify({ errcode: 40001, errmsg: "bad context" }),
    }));
    const client = new ILinkClient({ fetchImpl, timeoutMs: 1000 });
    client.token = "token-1";
    const ok = await client.sendMessage({
      clientId: "reply-failure",
      contextToken: "",
      text: "x",
      toUserId: "owner",
    });
    expect(ok).toBe(false);
  });

  it("raises on HTTP errors with a bounded excerpt", async () => {
    const { fetchImpl } = fakeFetch(() => ({
      body: "server exploded",
      status: 500,
    }));
    const client = new ILinkClient({ fetchImpl, timeoutMs: 1000 });
    await expect(client.requestQrCode()).rejects.toThrow(/HTTP 500/u);
  });
});
