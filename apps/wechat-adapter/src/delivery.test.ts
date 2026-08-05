import { describe, expect, it, vi } from "vitest";

import type { AttentionChannelGateway } from "./attention-client.js";
import { MessageDeliveryCoordinator } from "./delivery.js";
import type { ChannelGatewayReply, NormalizedWechatMessage, SafeLogger } from "./types.js";

const message: NormalizedWechatMessage = {
  action: "agent",
  appId: "wx1234567890abcdef",
  channelMessageId: "msg:42:1700000000",
  createTime: 1_700_000_000,
  fromUser: "openid-sensitive",
  rawInput: "hello",
  toUser: "gh_attention",
};

const logger: SafeLogger = {
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
};

describe("message delivery", () => {
  it("coalesces WeChat retries by channel message id", async () => {
    const send = vi.fn(async (): Promise<ChannelGatewayReply> => ({
      pendingRequestId: null,
      status: "completed",
      text: "done",
    }));
    const gateway: AttentionChannelGateway = {
      pollPending: vi.fn(),
      send,
    };
    const coordinator = new MessageDeliveryCoordinator(gateway, {
      asyncSender: null,
      logger,
      syncTimeoutMs: 100,
    });
    await expect(Promise.all([coordinator.deliver(message), coordinator.deliver(message)]))
      .resolves.toEqual([
        { text: "done", timedOut: false },
        { text: "done", timedOut: false },
      ]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("acks on timeout and later sends the result through the configured provider", async () => {
    let resolveGateway: ((reply: ChannelGatewayReply) => void) | undefined;
    const send = vi.fn(() => new Promise<ChannelGatewayReply>((resolve) => {
      resolveGateway = resolve;
    }));
    const sendText = vi.fn(async () => undefined);
    const gateway: AttentionChannelGateway = {
      pollPending: vi.fn(),
      send,
    };
    const coordinator = new MessageDeliveryCoordinator(gateway, {
      asyncSender: { sendText },
      logger,
      syncTimeoutMs: 5,
    });
    await expect(coordinator.deliver(message)).resolves.toEqual({
      text: "已收到，处理完成后会通过客服消息回复。",
      timedOut: true,
    });
    resolveGateway?.({ pendingRequestId: null, status: "completed", text: "later" });
    await vi.waitFor(() => expect(sendText).toHaveBeenCalledWith("openid-sensitive", "later"));
    await coordinator.deliver(message);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("converts internal API failures into a stable user-facing reply", async () => {
    const gateway: AttentionChannelGateway = {
      pollPending: vi.fn(),
      send: vi.fn(async () => { throw new Error("internal-secret-sensitive"); }),
    };
    const coordinator = new MessageDeliveryCoordinator(gateway, {
      asyncSender: null,
      logger,
      syncTimeoutMs: 100,
    });
    const result = await coordinator.deliver(message);
    expect(result.text).toBe("暂时无法处理，请稍后重试。");
    expect(result.text).not.toContain("sensitive");
  });
});
