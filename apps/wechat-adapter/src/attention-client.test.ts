import { describe, expect, it, vi } from "vitest";

import {
  AttentionGatewayError,
  HttpAttentionChannelGateway,
} from "./attention-client.js";
import type { NormalizedWechatMessage } from "./types.js";

const message: NormalizedWechatMessage = {
  action: "collect",
  appId: "wx1234567890abcdef",
  channelMessageId: "msg:1:1700000000",
  createTime: 1_700_000_000,
  fromUser: "openid-sensitive",
  rawInput: "https://example.com",
  toUser: "gh_attention",
};

function gateway(fetchImplementation: typeof fetch): HttpAttentionChannelGateway {
  return new HttpAttentionChannelGateway({
    apiBaseUrl: "http://127.0.0.1:3000",
    apiSecret: "internal-secret-sensitive",
    pendingPollIntervalMs: 1,
    pendingPollTimeoutMs: 1_000,
  }, fetchImplementation);
}

describe("Attention internal channel gateway", () => {
  it.each([
    [202, {
      bind_url: "https://attention.example/bind/once",
      pending_request_id: "12345678-1234-1234-1234-123456789abc",
      status: "binding_required",
    }, "请先绑定"],
    [403, {
      membership_url: "https://attention.example/account/membership",
      pending_request_id: "12345678-1234-1234-1234-123456789abc",
      status: "membership_required",
    }, "Member"],
    [200, { result: { answer: "引用回答" }, status: "completed" }, "引用回答"],
  ])("maps the existing %i channel response contract", async (status, payload, text) => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(payload), { status }));
    const result = await gateway(fetchMock as typeof fetch).send(message);
    expect(result.text).toContain(text);
    const [, request] = fetchMock.mock.calls[0] ?? [];
    expect(request?.redirect).toBe("error");
    expect(request?.headers).toMatchObject({
      authorization: "Bearer internal-secret-sensitive",
    });
    expect(JSON.parse(String(request?.body))).toMatchObject({
      action: "collect",
      channel_message_id: "msg:1:1700000000",
      provider: "wechat",
      subject_id: "openid-sensitive",
    });
  });

  it("polls a pending continuation until the internal API completes it", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "pending" }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        result: { status: "accepted" },
        status: "completed",
      }), { status: 200 }));
    const result = await gateway(fetchMock as typeof fetch)
      .pollPending("12345678-1234-1234-1234-123456789abc");
    expect(result).toMatchObject({ status: "completed", text: "已收藏，内容整理会在后台继续。" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([, init]) => init?.redirect === "error")).toBe(true);
  });

  it("does not expose an internal error body, openid or bearer secret", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      "internal-secret-sensitive openid-sensitive database trace",
      { status: 500 },
    ));
    const error = await gateway(fetchMock as typeof fetch).send(message)
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AttentionGatewayError);
    expect(String(error)).not.toContain("sensitive");
    expect(String(error)).not.toContain("database trace");
  });

  it("cancels a chunked gateway response as soon as it crosses the byte limit", async () => {
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
          controller.error(new Error("gateway response continued after cancellation"));
        },
      },
      { highWaterMark: 0 },
    );
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(body));

    await expect(gateway(fetchMock as typeof fetch).send(message)).rejects.toMatchObject({
      code: "gateway_invalid_response",
    });
    expect(cancelled).toBe(true);
    expect(pulls).toBe(1);
  });
});
