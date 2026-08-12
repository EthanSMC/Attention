import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { oauthScopesByAudience } from "@attention/auth";
import { AttentionToolSuccessOutputSchemas } from "@attention/contracts";
import type { AttentionDatabase } from "@attention/db";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ATTENTION_TOOL_CONTRACT_VERSION,
  ATTENTION_TOOL_NAMES,
  getAttentionPublicToolNames,
  type AttentionToolBaseContext,
  type AttentionToolDefinition,
} from "./attention-tool-registry";
import { createAttentionMcpServer } from "./mcp-tool-adapter";

const openClients: Client[] = [];
const fullMcpScopes = [...oauthScopesByAudience["attention-mcp"]];

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
    serviceOrigin: "https://attention.example",
    scopes: [],
    ...overrides,
  };
}

async function connectedClient(
  toolContext: AttentionToolBaseContext,
  registry?: readonly AttentionToolDefinition[],
): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createAttentionMcpServer(toolContext, registry);
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
    expect(ATTENTION_TOOL_CONTRACT_VERSION).toBe("1.3.0");
    expect(getAttentionPublicToolNames()).toEqual(ATTENTION_TOOL_NAMES);
    expect(new Set(ATTENTION_TOOL_NAMES).size).toBe(15);
  });

  it("exposes only scoped tools that a Free account can currently use", async () => {
    const client = await connectedClient(context({ scopes: fullMcpScopes }));

    await expect(client.listTools()).resolves.toMatchObject({
      tools: [
        { name: "attention_get_my_account" },
        { name: "attention_get_membership_status" },
        { name: "attention_list_collections" },
        { name: "attention_collect_content" },
        { name: "attention_submit_content_enrichment" },
        { name: "attention_select_collection_candidate" },
        { name: "attention_get_collection_status" },
        { name: "attention_update_collection" },
        { name: "attention_list_public_content" },
        { name: "attention_report_content" },
        { name: "attention_get_digest_settings" },
      ],
    });
    expect(client.getServerVersion()).toMatchObject({
      name: "attention-mcp-server",
      version: "0.1.0",
    });
  });

  it("advertises search only for a live Member with ai:search", async () => {
    const client = await connectedClient(
      context({ isMember: true, scopes: fullMcpScopes }),
    );

    const result = await client.listTools();
    expect(result.tools.map((tool) => tool.name)).toEqual(
      ATTENTION_TOOL_NAMES.filter(
        (name) =>
          name !== "attention_list_moderation_cases" &&
          name !== "attention_cast_moderation_vote",
      ),
    );
  });

  it("advertises court tools only to a live Filter with the matching scopes", async () => {
    const client = await connectedClient(
      context({ isFilter: true, scopes: fullMcpScopes }),
    );

    const result = await client.listTools();
    const courtList = result.tools.find(
      (tool) => tool.name === "attention_list_moderation_cases",
    );
    const courtVote = result.tools.find(
      (tool) => tool.name === "attention_cast_moderation_vote",
    );

    expect(courtList?.annotations).toMatchObject({
      destructiveHint: false,
      readOnlyHint: true,
    });
    expect(courtVote?.annotations).toMatchObject({
      destructiveHint: true,
      idempotentHint: true,
      readOnlyHint: false,
    });
    expect(courtVote?.inputSchema).toMatchObject({
      properties: {
        explicit_confirmation: { const: true },
      },
      required: expect.arrayContaining([
        "case_id",
        "decision",
        "explicit_confirmation",
      ]),
    });
  });

  it("publishes a strict structured-output contract for all fifteen tools", async () => {
    const client = await connectedClient(
      context({ isFilter: true, isMember: true, scopes: fullMcpScopes }),
    );

    const result = await client.listTools();
    expect(result.tools.map((tool) => tool.name)).toEqual(ATTENTION_TOOL_NAMES);
    for (const tool of result.tools) {
      expect(tool.outputSchema).toMatchObject({
        type: "object",
        oneOf: expect.arrayContaining([
          expect.any(Object),
          expect.objectContaining({
            properties: expect.objectContaining({ error: expect.any(Object) }),
          }),
        ]),
      });
    }
  });

  it("rejects an MCP court vote that does not carry literal user confirmation", async () => {
    const client = await connectedClient(
      context({
        isFilter: true,
        scopes: ["moderation:court:vote"],
      }),
    );

    await expect(
      client.callTool({
        arguments: {
          case_id: "00000000-0000-4000-8000-000000000001",
          decision: "public",
          explicit_confirmation: false,
        },
        name: "attention_cast_moderation_vote",
      }),
    ).resolves.toEqual({
      content: [
        {
          text: "invalid_request: Check the tool input and try again.",
          type: "text",
        },
      ],
      isError: true,
      structuredContent: {
        error: {
          code: "invalid_request",
          guidance: "Check the tool input and try again.",
          request_id: "request-1",
        },
      },
    });
  });

  it("publishes stable collect and one-time selection annotations", async () => {
    const client = await connectedClient(
      context({ scopes: ["collection:write"] }),
    );
    const result = await client.listTools();
    const collect = result.tools.find(
      (tool) => tool.name === "attention_collect_content",
    );
    const select = result.tools.find(
      (tool) => tool.name === "attention_select_collection_candidate",
    );
    const enrichment = result.tools.find(
      (tool) => tool.name === "attention_submit_content_enrichment",
    );

    expect(collect?.inputSchema).toMatchObject({
      required: expect.arrayContaining(["idempotency_key", "input"]),
    });
    expect(collect?.annotations?.idempotentHint).toBe(true);
    expect(select?.annotations?.idempotentHint).toBe(false);
    expect(enrichment?.annotations).toMatchObject({
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: false,
    });
    expect(enrichment?.inputSchema).toMatchObject({
      required: expect.arrayContaining([
        "content_id",
        "idempotency_key",
        "summary",
        "tags",
      ]),
    });
  });

  it("marks content reporting as impactful and requires exact current confirmation", async () => {
    const client = await connectedClient(
      context({ scopes: ["moderation:write"] }),
    );
    const report = (await client.listTools()).tools.find(
      (tool) => tool.name === "attention_report_content",
    );

    expect(report?.annotations).toMatchObject({
      destructiveHint: true,
      idempotentHint: true,
      readOnlyHint: false,
    });
    expect(report?.inputSchema).toMatchObject({
      properties: { explicit_confirmation: { const: true } },
      required: expect.arrayContaining([
        "explicit_confirmation",
        "public_content_id",
        "reason_code",
      ]),
    });
  });

  it("does not advertise or dispatch tools outside the token scope", async () => {
    const client = await connectedClient(context());

    await expect(client.listTools()).resolves.toMatchObject({ tools: [] });

    await expect(
      client.callTool({
        arguments: {},
        name: "attention_list_collections",
      }),
    ).resolves.toEqual({
      content: [
        {
          text: "tool_not_found: Refresh the Attention tool list before calling this tool.",
          type: "text",
        },
      ],
      isError: true,
      structuredContent: {
        error: {
          code: "tool_not_found",
          guidance: "Refresh the Attention tool list before calling this tool.",
          request_id: "request-1",
        },
      },
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
      structuredContent: {
        error: {
          code: "invalid_request",
          guidance: "Check the tool input and try again.",
          request_id: "request-1",
        },
      },
    });
  });

  it("encodes actionable error metadata in the MCP structured result", async () => {
    const metadataTool: AttentionToolDefinition = {
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: false,
      },
      contractVersion: ATTENTION_TOOL_CONTRACT_VERSION,
      description: "Exercise the MCP structured error encoder.",
      inputSchema: z.object({}).strict(),
      outputSchema:
        AttentionToolSuccessOutputSchemas.attention_report_content,
      invoke: async () => ({
        code: "report_rate_limited",
        guidance: "Wait before opening another moderation case.",
        ok: false,
        requiredEntitlement: "filter",
        requiredScope: "moderation:write",
        retryAfterSeconds: 321,
      }),
      isVisible: () => true,
      name: "attention_report_content",
      title: "Test structured error metadata",
    };
    const client = await connectedClient(context(), [metadataTool]);

    await expect(
      client.callTool({
        arguments: {},
        name: "attention_report_content",
      }),
    ).resolves.toEqual({
      content: [
        {
          text: "report_rate_limited: Wait before opening another moderation case.",
          type: "text",
        },
      ],
      isError: true,
      structuredContent: {
        error: {
          code: "report_rate_limited",
          guidance: "Wait before opening another moderation case.",
          request_id: "request-1",
          required_entitlement: "filter",
          required_scope: "moderation:write",
          retry_after_seconds: 321,
        },
      },
    });
  });
});
