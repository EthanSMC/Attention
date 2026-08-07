import { afterEach, describe, expect, it } from "vitest";

import { handleRuntimeProtectedResourceMetadataRequest } from "../app/.well-known/oauth-protected-resource/api/runtime/route";
import {
  oauthResourceMapFromOrigin,
  oauthResourceMetadataUrl,
} from "./oauth-resources";

const originalRuntimeUrl = process.env.ATTENTION_CHANNEL_RUNTIME_PUBLIC_URL;
const originalMcpUrl = process.env.ATTENTION_MCP_PUBLIC_URL;
const originalSyncUrl = process.env.ATTENTION_SYNC_PUBLIC_URL;

afterEach(() => {
  if (originalRuntimeUrl === undefined) {
    delete process.env.ATTENTION_CHANNEL_RUNTIME_PUBLIC_URL;
  } else {
    process.env.ATTENTION_CHANNEL_RUNTIME_PUBLIC_URL = originalRuntimeUrl;
  }
  if (originalMcpUrl === undefined) {
    delete process.env.ATTENTION_MCP_PUBLIC_URL;
  } else {
    process.env.ATTENTION_MCP_PUBLIC_URL = originalMcpUrl;
  }
  if (originalSyncUrl === undefined) {
    delete process.env.ATTENTION_SYNC_PUBLIC_URL;
  } else {
    process.env.ATTENTION_SYNC_PUBLIC_URL = originalSyncUrl;
  }
});

describe("OAuth resource routing", () => {
  it("derives distinct default URLs for all three protected resources", () => {
    delete process.env.ATTENTION_CHANNEL_RUNTIME_PUBLIC_URL;
    delete process.env.ATTENTION_MCP_PUBLIC_URL;
    delete process.env.ATTENTION_SYNC_PUBLIC_URL;

    expect(oauthResourceMapFromOrigin("https://attention.example/path")).toEqual({
      "attention-channel-runtime": "https://attention.example/api/runtime",
      "attention-mcp": "https://attention.example/mcp",
      "attention-sync": "https://attention.example/api/sync",
    });
  });

  it("maps each audience to its own protected-resource metadata URL", () => {
    const request = new Request("https://attention.example/api/runtime");

    expect(oauthResourceMetadataUrl(request, "attention-mcp")).toBe(
      "https://attention.example/.well-known/oauth-protected-resource",
    );
    expect(oauthResourceMetadataUrl(request, "attention-sync")).toBe(
      "https://attention.example/.well-known/oauth-protected-resource/api/sync",
    );
    expect(oauthResourceMetadataUrl(request, "attention-channel-runtime")).toBe(
      "https://attention.example/.well-known/oauth-protected-resource/api/runtime",
    );
  });

  it("publishes runtime protected-resource metadata with only runtime scopes", async () => {
    const response = handleRuntimeProtectedResourceMetadataRequest(
      new Request(
        "https://attention.example/.well-known/oauth-protected-resource/api/runtime",
      ),
    );

    await expect(response.json()).resolves.toEqual({
      authorization_servers: ["https://attention.example"],
      bearer_methods_supported: ["header"],
      resource: "https://attention.example/api/runtime",
      scopes_supported: [
        "runtime:register",
        "runtime:heartbeat",
        "channel:bind:report",
        "channel:disconnect:report",
      ],
    });
  });
});
