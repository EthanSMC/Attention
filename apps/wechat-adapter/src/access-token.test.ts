import { describe, expect, it, vi } from "vitest";

import {
  WechatAccessTokenProvider,
  WechatApiError,
  WechatCustomerServiceSender,
} from "./access-token.js";

describe("WeChat access tokens and customer-service replies", () => {
  it("coalesces requests, caches tokens and refreshes before expiry", async () => {
    let now = 1_000_000;
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      access_token: `token-${"x".repeat(20)}`,
      expires_in: 7200,
    }), { status: 200 }));
    const provider = new WechatAccessTokenProvider({
      apiBaseUrl: "https://api.weixin.qq.com",
      appId: "wx1234567890abcdef",
      appSecret: "app-secret-sensitive",
    }, fetchMock as typeof fetch, () => now);

    await expect(Promise.all([provider.getToken(), provider.getToken()]))
      .resolves.toEqual([`token-${"x".repeat(20)}`, `token-${"x".repeat(20)}`]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe("error");
    await provider.getToken();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    now += 7_000_000;
    await provider.getToken();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails with a stable error that does not expose WeChat response data or secrets", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      errmsg: "app-secret-sensitive openid-sensitive",
      errcode: 40013,
    }), { status: 401 }));
    const provider = new WechatAccessTokenProvider({
      apiBaseUrl: "https://api.weixin.qq.com",
      appId: "wx1234567890abcdef",
      appSecret: "app-secret-sensitive",
    }, fetchMock as typeof fetch);
    const error = await provider.getToken().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(WechatApiError);
    expect(String(error)).toBe("WechatApiError: wechat_api_rejected");
    expect(String(error)).not.toContain("sensitive");
  });

  it("cancels a chunked provider response as soon as it crosses the byte limit", async () => {
    let cancelled = false;
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        cancel() {
          cancelled = true;
        },
        pull(controller) {
          pulls += 1;
          if (pulls === 1) {
            controller.enqueue(new Uint8Array(1_000_001));
            return;
          }
          controller.error(new Error("provider response continued after cancellation"));
        },
      },
      { highWaterMark: 0 },
    );
    const provider = new WechatAccessTokenProvider({
      apiBaseUrl: "https://api.weixin.qq.com",
      appId: "wx1234567890abcdef",
      appSecret: "app-secret-sensitive",
    }, vi.fn<typeof fetch>(async () => new Response(body)) as typeof fetch);

    await expect(provider.getToken()).rejects.toMatchObject({
      code: "invalid_wechat_response",
    });
    expect(cancelled).toBe(true);
    expect(pulls).toBe(1);
  });

  it("sends a bounded customer-service text payload and invalidates an expired token", async () => {
    const tokenFetch = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      access_token: `token-${"x".repeat(20)}`,
      expires_in: 7200,
    })));
    const provider = new WechatAccessTokenProvider({
      apiBaseUrl: "https://api.weixin.qq.com",
      appId: "wx1234567890abcdef",
      appSecret: "app-secret-sensitive",
    }, tokenFetch as typeof fetch);
    const sendFetch = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ errcode: 0, errmsg: "ok" }),
    ));
    const sender = new WechatCustomerServiceSender(
      "https://api.weixin.qq.com",
      provider,
      sendFetch as typeof fetch,
    );
    await sender.sendText("openid-sensitive", "done");
    const [url, request] = sendFetch.mock.calls[0] ?? [];
    expect(String(url)).toContain("/cgi-bin/message/custom/send?access_token=");
    expect(request?.redirect).toBe("error");
    expect(JSON.parse(String(request?.body))).toEqual({
      msgtype: "text",
      text: { content: "done" },
      touser: "openid-sensitive",
    });

    sendFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      errcode: 42001,
      errmsg: "expired",
    })));
    await expect(sender.sendText("openid-sensitive", "again")).resolves.toBeUndefined();
    expect(tokenFetch).toHaveBeenCalledTimes(2);
    expect(sendFetch).toHaveBeenCalledTimes(3);
  });
});
