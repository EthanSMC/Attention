import { describe, expect, it } from "vitest";

import { defaultChannelState } from "./state";
import {
  completeInbound,
  enqueueInbound,
  enqueueOutbound,
  markOutboundSent,
  outboundIdentifier,
} from "./queue";

const message = (id: string) => ({
  contextToken: `ctx-${id}`,
  fromUserId: "owner",
  itemList: [{ text_item: { text: `https://example.com/${id}` }, type: 1 }],
  raw: { client_id: id, from_user_id: "owner" },
});

describe("durable channel queues", () => {
  it("preserves every inbound message instead of dropping a batch above five", () => {
    const state = defaultChannelState();
    expect(enqueueInbound(state, Array.from({ length: 8 }, (_, i) => message(`m${i}`)))).toBe(8);
    expect(state.pendingInbound.map((item) => item.id)).toEqual([
      "m0",
      "m1",
      "m2",
      "m3",
      "m4",
      "m5",
      "m6",
      "m7",
    ]);
    expect(state.pendingInbound.every((item) => item.blockedBy === null)).toBe(
      true,
    );
  });

  it("deduplicates pending and already completed deliveries", () => {
    const state = defaultChannelState();
    enqueueInbound(state, [message("same"), message("same")]);
    expect(state.pendingInbound).toHaveLength(1);
    completeInbound(state, "same");
    expect(enqueueInbound(state, [message("same")])).toBe(0);
  });

  it("keeps outbound replies until an explicit successful send", () => {
    const state = defaultChannelState();
    enqueueOutbound(state, {
      contextToken: "ctx",
      id: "reply:m1:0",
      text: "已收藏",
      toUserId: "owner",
    });
    expect(state.pendingOutbound).toHaveLength(1);
    markOutboundSent(state, "different-id");
    expect(state.pendingOutbound).toHaveLength(1);
    markOutboundSent(state, "reply:m1:0");
    expect(state.pendingOutbound).toHaveLength(0);
  });

  it("derives a stable iLink client id for retry-safe sends", () => {
    expect(
      outboundIdentifier({ inboundId: "m1", kind: "result", index: 0 }),
    ).toBe(
      outboundIdentifier({ inboundId: "m1", kind: "result", index: 0 }),
    );
    expect(
      outboundIdentifier({ inboundId: "m1", kind: "result", index: 0 }),
    ).not.toBe(
      outboundIdentifier({ inboundId: "m1", kind: "result", index: 1 }),
    );
  });
});
