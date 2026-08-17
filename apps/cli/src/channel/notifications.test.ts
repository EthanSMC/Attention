import { describe, expect, it, vi } from "vitest";

import { defaultChannelState } from "./state";
import {
  enqueueSummaryNotifications,
  pollSummaryNotifications,
} from "./notifications";

const installationId = "11111111-1111-4111-8111-111111111111";
const bindingId = "22222222-2222-4222-8222-222222222222";
const notification = {
  completed_at: "2026-08-14T08:30:00.000Z",
  content_id: "33333333-3333-4333-8333-333333333333",
  notification_id: "44444444-4444-4444-8444-444444444444",
  original_url: "https://example.com/article",
  summary: "这是一段摘要。",
  title: "测试文章",
} as const;

describe("summary notification polling", () => {
  it("refreshes a rejected runtime token once and validates the response", async () => {
    const accessToken = vi
      .fn()
      .mockResolvedValueOnce("stale-runtime-token")
      .mockResolvedValueOnce("fresh-runtime-token");
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [notification],
            next_cursor:
              "2026-08-14T08:30:00.000Z|44444444-4444-4444-8444-444444444444",
          }),
          { status: 200 },
        ),
      );

    const result = await pollSummaryNotifications({
      accessTokenProvider: { accessToken },
      bindingId,
      fetchImpl,
      installationId,
      runtimeBaseUrl: "https://attention.example/api/runtime",
    });

    expect(result?.items).toEqual([notification]);
    expect(accessToken).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        forceRefresh: false,
        scopes: expect.arrayContaining(["channel:notifications:read"]),
      }),
    );
    expect(accessToken).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        forceRefresh: true,
        scopes: expect.arrayContaining(["channel:notifications:read"]),
      }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      expect.any(URL),
      expect.objectContaining({
        headers: { authorization: "Bearer fresh-runtime-token" },
        method: "GET",
      }),
    );
  });

  it("durably queues a fixed WeChat reply and advances the cursor", () => {
    const state = defaultChannelState();
    state.ownerUserId = "wechat-owner";
    state.contextTokens = { "wechat-owner": "ctx-owner" };

    expect(
      enqueueSummaryNotifications(state, {
        items: [notification],
        next_cursor:
          "2026-08-14T08:30:00.000Z|44444444-4444-4444-8444-444444444444",
      }),
    ).toBe(true);
    expect(state.summaryNotificationCursor).toContain(
      notification.notification_id,
    );
    expect(state.pendingOutbound).toEqual([
      {
        contextToken: "ctx-owner",
        id: `summary-ready-${notification.notification_id}`,
        text:
          "你收藏的《测试文章》摘要已完成：\n\n这是一段摘要。\n\n查看原文：https://example.com/article",
        toUserId: "wechat-owner",
      },
    ]);

    expect(
      enqueueSummaryNotifications(state, {
        items: [notification],
        next_cursor: state.summaryNotificationCursor,
      }),
    ).toBe(false);
    expect(state.pendingOutbound).toHaveLength(1);
  });

  it("does not advance the cursor until a bound owner can be queued", () => {
    const state = defaultChannelState();
    expect(
      enqueueSummaryNotifications(state, {
        items: [notification],
        next_cursor:
          "2026-08-14T08:30:00.000Z|44444444-4444-4444-8444-444444444444",
      }),
    ).toBe(false);
    expect(state.summaryNotificationCursor).toBeNull();
    expect(state.pendingOutbound).toEqual([]);
  });
});
