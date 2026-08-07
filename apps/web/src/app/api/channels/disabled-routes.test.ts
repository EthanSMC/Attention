import { describe, expect, it } from "vitest";

import { DELETE as revokeChannelIdentity } from "../account/channels/[identityId]/route";
import { POST as bindChannel } from "./bind/route";
import { POST as receiveChannelMessage } from "./messages/route";
import { GET as readPendingChannelRequest } from "./pending/[pendingRequestId]/route";

const disabledHandlers = [
  ["messages", receiveChannelMessage],
  ["bind", bindChannel],
  ["pending", readPendingChannelRequest],
  ["account revoke", revokeChannelIdentity],
] as const;

describe("disabled first-party channel product routes", () => {
  it.each(disabledHandlers)("returns one stable 410 response for %s", async (_, handler) => {
    const response = await handler();

    expect(response.status).toBe(410);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "hosted_channel_not_available",
        message:
          "This product entry is not available in the infrastructure-only release.",
      },
      release_scope: "local_agent_infrastructure",
    });
  });

  it("cannot generate the deleted browser binding path", async () => {
    const responses = await Promise.all(
      disabledHandlers.map(async ([, handler]) => await handler()),
    );
    const bodies = await Promise.all(responses.map(async (response) => await response.text()));

    expect(bodies.join("\n")).not.toContain("/channel/bind");
    expect(bodies.join("\n")).not.toContain("bind_url");
  });
});
