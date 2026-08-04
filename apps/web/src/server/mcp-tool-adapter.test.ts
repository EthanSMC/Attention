import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AttentionDatabase } from "@attention/db";
import { afterEach, describe, expect, it } from "vitest";

import {
  ATTENTION_TOOL_CONTRACT_VERSION,
  ATTENTION_TOOL_NAMES,
  getAttentionPublicToolNames,
  type AttentionToolBaseContext,
} from "./attention-tool-registry";
import { createAttentionMcpServer } from "./mcp-tool-adapter";

const openClients: Client[] = [];

function context(
  overrides: Partial<AttentionToolBaseContext> = {},
): AttentionToolBaseContext {
  return {
    accountId: "account-1",
    caller: {
      clientId: "client-1",
      credentialId: "token-1",
      credentialKind: "oauth",
      entrypoint: "hosted_mcp",
    },
    getDatabase: () => ({} as AttentionDatabase),
    isFilter: false,
    isMember: false,
    requestId: "request-1",
    scopes: [],
    ...overrides,
  };
}

async function connectedClient(
  toolContext: AttentionToolBaseContext,
): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createAttentionMcpServer(toolContext);
  const client = new Client({ name: "attention-registry-test", version: "1" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  openClients.push(client);
  return client;
}

afterEach(async () => {
  await Promise.all(openClients.splice(0).map((client) => client.close()));
});

describe("canonical Attention tool registry", () => {
  it("exports the stable contract version and a defensive public-name list", () => {
    expect(ATTENTION_TOOL_CONTRACT_VERSION).toBe("1.0.0");
    expect(getAttentionPublicToolNames()).toEqual(ATTENTION_TOOL_NAMES);
    expect(new Set(ATTENTION_TOOL_NAMES).size).toBe(7);
  });

  it("exposes six Core tools to Free credentials", async () => {
    const client = await connectedClient(context());

    await expect(client.listTools()).resolves.toMatchObject({
      tools: [
        { name: "attention_list_collections" },
        { name: "attention_collect_content" },
        { name: "attention_select_collection_candidate" },
        { name: "attention_get_collection_status" },
        { name: "attention_update_collection" },
        { name: "attention_list_public_content" },
      ],
    });
    expect(client.getServerVersion()).toMatchObject({
      name: "attention-mcp-server",
      version: "0.1.0",
    });
  });

  it("advertises search only for a live Member with ai:search", async () => {
    const client = await connectedClient(
      context({ isMember: true, scopes: ["ai:search"] }),
    );

    const result = await client.listTools();
    expect(result.tools.map((tool) => tool.name)).toEqual(ATTENTION_TOOL_NAMES);
  });

  it("publishes stable collect and one-time selection annotations", async () => {
    const client = await connectedClient(context());
    const result = await client.listTools();
    const collect = result.tools.find(
      (tool) => tool.name === "attention_collect_content",
    );
    const select = result.tools.find(
      (tool) => tool.name === "attention_select_collection_candidate",
    );

    expect(collect?.inputSchema).toMatchObject({
      required: expect.arrayContaining(["idempotency_key", "input"]),
    });
    expect(collect?.annotations?.idempotentHint).toBe(true);
    expect(select?.annotations?.idempotentHint).toBe(false);
  });

  it("keeps base tools discoverable and returns the existing scope error", async () => {
    const client = await connectedClient(context());

    await expect(
      client.callTool({
        arguments: {},
        name: "attention_list_collections",
      }),
    ).resolves.toEqual({
      content: [
        {
          text: "insufficient_scope: Reconnect with collection:read.",
          type: "text",
        },
      ],
      isError: true,
    });
  });

  it("routes malformed MCP arguments through the stable Registry error", async () => {
    const client = await connectedClient(
      context({ scopes: ["collection:write"] }),
    );

    await expect(
      client.callTool({
        arguments: {
          input: "https://example.org/article",
          visibility: "private",
        },
        name: "attention_collect_content",
      }),
    ).resolves.toEqual({
      content: [
        {
          text: "invalid_request: Check the tool input and try again.",
          type: "text",
        },
      ],
      isError: true,
    });
  });
});
