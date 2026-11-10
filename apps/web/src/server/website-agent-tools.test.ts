import type { AttentionDatabase } from "@attention/db";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { AttentionToolBaseContext, AttentionToolDefinition, AttentionToolName } from "./attention-tool-registry";
import { createWebsiteAgentTools } from "./website-agent-tools";

const accountId = "00000000-0000-4000-8000-000000000001";
const operationId = "00000000-0000-4000-8000-000000000002";
const context: AttentionToolBaseContext = {
  accountId, caller: { credentialId: operationId, credentialKind: "session", entrypoint: "hosted_agent", clientId: "attention-website" },
  getDatabase: () => ({} as AttentionDatabase), isMember: true, isFilter: true,
  requestId: operationId, scopes: ["collection:read", "collection:write"], serviceOrigin: "https://attention.example",
};
function definition(name: AttentionToolName, visible = true): AttentionToolDefinition {
  return { name, title: name, description: name, contractVersion: "1.7.0",
    inputSchema: z.object({}).strict(), outputSchema: z.record(z.string(), z.unknown()),
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    isVisible: () => visible, invoke: vi.fn(async () => ({ ok: true as const, value: { status: "accepted" } })),
  };
}
const execution = () => ({ signal: new AbortController().signal, toolCallId: "tool-1" });

describe("website transport shares the Attention tool registry", () => {
  it("exposes only permitted registry tools and never consequential mutation tools", () => {
    const registry = [definition("attention_list_collections"), definition("attention_collect_content"),
      definition("attention_update_collection"), definition("attention_cast_moderation_vote"),
      definition("attention_update_digest_settings"), definition("attention_submit_content_enrichment"),
      definition("attention_read_collection_source"), definition("attention_report_content")];
    const base = { context, getCurrentContext: async () => context, operationId, query: "question", collect: false, readSources: false, registry };
    expect(createWebsiteAgentTools(base).map(tool => tool.name)).toEqual(["attention_list_collections"]);
    expect(createWebsiteAgentTools({ ...base, collect: true, readSources: true }).map(tool => tool.name))
      .toEqual(["attention_list_collections", "attention_collect_content", "attention_read_collection_source"]);
  });
  it("fixes collection input, private visibility and retry identity outside model control", async () => {
    const collect = definition("attention_collect_content");
    const [tool] = createWebsiteAgentTools({ context, getCurrentContext: async () => context, operationId,
      query: "save https://example.com/original", collect: true, readSources: false, registry: [collect] });
    expect(tool!.inputSchema).toMatchObject({ type: "object", additionalProperties: false, properties: {} });
    await tool!.invoke({ input: "https://evil.example/unrequested", visibility: "public", idempotency_key: "invented" }, execution());
    expect(collect.invoke).toHaveBeenCalledWith(expect.objectContaining({ accountId, caller: context.caller }), {
      input: "save https://example.com/original", visibility: "private", idempotency_key: `website:${operationId}`,
    });
  });
  it.each([null, { ...context, accountId: operationId }, { ...context, isMember: false }])("rechecks live account authority before dispatch: %s", async current => {
    const list = definition("attention_list_collections");
    const [tool] = createWebsiteAgentTools({ context, getCurrentContext: async () => current, operationId, query: "query", collect: false, readSources: false, registry: [list] });
    expect(await tool!.invoke({}, execution())).toMatchObject({ ok: false, code: "permission_revoked" });
    expect(list.invoke).not.toHaveBeenCalled();
  });
  it("does not dispatch a cancelled call or a tool no longer visible", async () => {
    const list = definition("attention_list_collections");
    list.isVisible = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    const [tool] = createWebsiteAgentTools({ context, getCurrentContext: async () => context, operationId, query: "query", collect: false, readSources: false, registry: [list] });
    expect(await tool!.invoke({}, execution())).toMatchObject({ ok: false });
    const controller = new AbortController(); controller.abort();
    await expect(tool!.invoke({}, { ...execution(), signal: controller.signal })).rejects.toThrow();
    expect(list.invoke).not.toHaveBeenCalled();
  });
});
