import type { AttentionDatabase } from "@attention/db";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { ATTENTION_TOOL_NAMES, attentionToolRegistry, type AttentionToolBaseContext, type AttentionToolDefinition, type AttentionToolName } from "./attention-tool-registry";
import { createWebsiteAgentTools, WEBSITE_AGENT_READ_SCOPES, WEBSITE_AGENT_TOOL_SCOPES } from "./website-agent-tools";

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
  it("exposes moderation-case reads only through the canonical Filter and scope policy", () => {
    const court = attentionToolRegistry.find(tool => tool.name === "attention_list_moderation_cases")!;
    const filter = { ...context, scopes: [...WEBSITE_AGENT_READ_SCOPES] };
    const base = { context: filter, getCurrentContext: async () => filter, operationId,
      query: "List my moderation cases", collect: false, readSources: false, registry: [court] };
    expect(court.annotations.readOnlyHint).toBe(true);
    expect(createWebsiteAgentTools(base).map(tool => tool.name)).toEqual(["attention_list_moderation_cases"]);
    expect(createWebsiteAgentTools({ ...base, context: { ...filter, isFilter: false } })).toEqual([]);
    expect(createWebsiteAgentTools({ ...base, context: { ...filter, scopes: ["collection:read"] } })).toEqual([]);
  });
  it.each(["filter", "scope"])("blocks moderation reads after live %s revocation", async revoked => {
    const invoke = vi.fn();
    const court = { ...attentionToolRegistry.find(tool => tool.name === "attention_list_moderation_cases")!, invoke };
    const filter = { ...context, scopes: [...WEBSITE_AGENT_READ_SCOPES] };
    const current = revoked === "filter" ? { ...filter, isFilter: false } : { ...filter, scopes: [] };
    const [tool] = createWebsiteAgentTools({ context: filter, getCurrentContext: async () => current, operationId,
      query: "List my moderation cases", collect: false, readSources: false, registry: [court] });
    expect(await tool!.invoke({}, execution())).toMatchObject({ ok: false, code: "permission_revoked" });
    expect(invoke).not.toHaveBeenCalled();
  });
  it("dispatches an authorized moderation read through the canonical tool without granting vote access", async () => {
    const invoke = vi.fn(async () => ({ ok: true as const, value: { cases: [] } }));
    const court = { ...attentionToolRegistry.find(tool => tool.name === "attention_list_moderation_cases")!, invoke };
    const filter = { ...context, scopes: [...WEBSITE_AGENT_READ_SCOPES] };
    const [tool] = createWebsiteAgentTools({ context: filter, getCurrentContext: async () => filter, operationId,
      query: "List my moderation cases", collect: false, readSources: false, registry: [court] });
    expect(WEBSITE_AGENT_READ_SCOPES).not.toContain("moderation:court:vote");
    expect(await tool!.invoke({ limit: 5, offset: 0 }, execution())).toMatchObject({ ok: true });
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ accountId, isFilter: true,
      scopes: filter.scopes, caller: context.caller }), { limit: 5, offset: 0 });
  });
  it("exposes every entitled canonical capability with explicit gates and fails closed for unknown names", () => {
    const principal = { ...context, scopes: [...WEBSITE_AGENT_TOOL_SCOPES] };
    const registry = [...attentionToolRegistry, definition("attention_run_shell" as AttentionToolName)];
    const base = { context: principal, getCurrentContext: async () => principal, operationId, query: "question", collect: false, readSources: false, registry };
    expect(createWebsiteAgentTools(base).map(tool => tool.name)).toEqual([...ATTENTION_TOOL_NAMES]);
    const member = { ...principal, isFilter: false };
    expect(createWebsiteAgentTools({ ...base, context: member }).map(tool => tool.name))
      .not.toContain("attention_cast_moderation_vote");
    expect(createWebsiteAgentTools({ ...base, context: { ...principal, scopes: [] } })).toEqual([]);
  });
  it("fixes collection input, private visibility and retry identity outside model control", async () => {
    const collect = definition("attention_collect_content");
    const [tool] = createWebsiteAgentTools({ context, getCurrentContext: async () => context, operationId,
      query: "save https://example.com/original", collect: true, readSources: false, registry: [collect] });
    expect(tool!.inputSchema).toMatchObject({ type: "object", additionalProperties: false, properties: { visibility: { enum: ["private", "public"] } } });
    expect(await tool!.invoke({ input: "https://evil.example/unrequested", visibility: "public", idempotency_key: "invented" }, execution()))
      .toMatchObject({ ok: false, code: "invalid_request" });
    expect(collect.invoke).not.toHaveBeenCalled();
    await tool!.invoke({ visibility: "private" }, execution());
    expect(collect.invoke).toHaveBeenCalledWith(expect.objectContaining({ accountId, caller: context.caller }), {
      input: "save https://example.com/original", visibility: "private", idempotency_key: `website:${operationId}`,
    });
  });
  it.each([
    ["attention_collect_content", {}, "collection_consent_required"],
    ["attention_collect_content", { visibility: "public" }, "public_collection_review_required"],
    ["attention_read_collection_source", {}, "source_read_consent_required"],
    ["attention_select_collection_candidate", {}, "candidate_selection_review_required"],
    ["attention_submit_content_enrichment", {}, "source_evidence_and_merge_review_required"],
    ["attention_update_collection", { collection_id: operationId, visibility: "public" }, "action_review_unavailable"],
  ] as const)("returns the explicit gate for %s without invoking Core", async (name, args, code) => {
    const principal = { ...context, scopes: [...WEBSITE_AGENT_TOOL_SCOPES] };
    const invoke = vi.fn(), original = attentionToolRegistry.find(tool => tool.name === name)!;
    const [tool] = createWebsiteAgentTools({ context: principal, getCurrentContext: async () => principal, operationId,
      query: "question", collect: false, readSources: false, registry: [{ ...original, invoke }] });
    expect(await tool!.invoke(args, execution())).toMatchObject({ ok: false, code });
    expect(invoke).not.toHaveBeenCalled();
  });
  it("routes reviewed actions only to trusted proposal preparation and rejects fabricated confirmation", async () => {
    const principal = { ...context, scopes: [...WEBSITE_AGENT_TOOL_SCOPES] };
    const invoke = vi.fn(), proposeAction = vi.fn(async () => ({ status: "requires_confirmation", action_id: operationId }));
    const original = attentionToolRegistry.find(tool => tool.name === "attention_report_content")!;
    const [tool] = createWebsiteAgentTools({ context: principal, getCurrentContext: async () => principal, operationId,
      query: "report", collect: false, readSources: false, registry: [{ ...original, invoke }], proposeAction });
    const args = { public_content_id: operationId, reason_code: "spam", details: "Specific reason" };
    expect(await tool!.invoke({ ...args, explicit_confirmation: true }, execution())).toMatchObject({ ok: false, code: "invalid_request" });
    expect(proposeAction).not.toHaveBeenCalled();
    expect(await tool!.invoke(args, execution())).toMatchObject({ status: "requires_confirmation" });
    expect(proposeAction).toHaveBeenCalledWith(original.name, args, expect.objectContaining({ toolCallId: "tool-1" }));
    expect(invoke).not.toHaveBeenCalled();
  });
  it("dispatches source reads only with the current request's source consent", async () => {
    const reader = definition("attention_read_collection_source");
    const [tool] = createWebsiteAgentTools({ context, getCurrentContext: async () => context, operationId,
      query: "read", collect: false, readSources: true, registry: [reader] });
    await tool!.invoke({ collection_id: operationId, attempt_ref: "source-1" }, execution());
    expect(reader.invoke).toHaveBeenCalledTimes(1);
  });
  it.each([null, { ...context, accountId: operationId }, { ...context, isMember: false },
    { ...context, caller: { ...context.caller, credentialId: accountId } }])("rechecks live account authority before dispatch: %s", async current => {
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
