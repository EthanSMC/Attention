import { type AttentionTransaction } from "@attention/db";
import { describe, expect, it, vi } from "vitest";
import { attentionToolRegistry, type AttentionToolBaseContext } from "./attention-tool-registry";
import { websiteAgentActionArgumentsHash, type WebsiteAgentActionProposal } from "./website-agent-action-policy";
import { invokeReviewedWebsiteDatabaseAction, lockWebsiteAgentActionAuthority,
  type WebsiteAgentReviewedExecutionDependencies } from "./website-agent-action-execution";

const owner = "00000000-0000-4000-8000-000000000001";
const actionId = "00000000-0000-4000-8000-000000000002";
const args = { collection_id: actionId, visibility: "public" };
const proposal: WebsiteAgentActionProposal = { version: 1, toolName: "attention_update_collection", contractVersion: "1.7.0", arguments: args,
  argumentsHash: websiteAgentActionArgumentsHash("attention_update_collection", args), targetFingerprint: "a".repeat(64),
  requiredScopes: ["collection:write"], review: { title: "Public collection", details: [{ label: "Visibility", value: "public" }], consequences: ["Publicly visible"] } };
const context: AttentionToolBaseContext = { accountId: owner, caller: { clientId: "attention-website", credentialId: owner,
  credentialKind: "session", entrypoint: "hosted_agent" }, getDatabase: () => { throw new Error("root_database_must_not_be_used"); },
  isMember: true, isFilter: true, scopes: ["collection:write"], requestId: actionId, serviceOrigin: "https://attention.example" };
function fixture() {
  let effects = 0;
  const tx = { execute: vi.fn(async () => [{ id: owner }]), transaction: vi.fn() } as unknown as AttentionTransaction;
  vi.mocked(tx.transaction).mockImplementation(async work => {
    const before = effects;
    try { return await work(tx); } catch (error) { effects = before; throw error; }
  });
  const invoke = vi.fn(async () => { effects += 1; return { ok: true as const, value: { visibility: "public" } }; });
  const definition = { ...attentionToolRegistry.find(tool => tool.name === proposal.toolName)!, invoke };
  const deps: WebsiteAgentReviewedExecutionDependencies = { registry: [definition], lockAuthority: vi.fn(async () => {}),
    lockTarget: vi.fn(async () => {}), revalidateProposal: vi.fn(async () => {}) };
  const revalidate = vi.fn(async () => context);
  const input = { context, proposal, actionId, signal: new AbortController().signal, revalidate };
  return { tx, deps, invoke, input, effects: () => effects };
}

describe("reviewed canonical database invocation", () => {
  it("keeps Core and nested transactions on the supplied transaction and revalidates twice", async () => {
    const f = fixture();
    const result = await invokeReviewedWebsiteDatabaseAction(f.tx, f.input, f.deps);
    expect(result.result.ok).toBe(true); expect(f.effects()).toBe(1);
    expect(f.deps.lockAuthority).toHaveBeenCalledWith(f.tx, { accountId: owner, authSessionId: owner });
    expect(f.deps.lockTarget).toHaveBeenCalledWith(f.tx, proposal, owner);
    expect(f.input.revalidate).toHaveBeenCalledTimes(2);
    const call = vi.mocked(f.deps.registry[0]!.invoke).mock.calls[0]!;
    expect(call[0].getDatabase()).toBe(f.tx); expect(call[1]).toEqual(args);
  });
  it("rolls back all effects when canonical invoke returns a safe failure after writing", async () => {
    const f = fixture(), original = f.deps.registry[0]!.invoke;
    f.deps.registry = [{ ...f.deps.registry[0]!, invoke: async (...params) => {
      await original(...params); return { ok: false, code: "internal_error", guidance: "Try later" };
    } }];
    expect((await invokeReviewedWebsiteDatabaseAction(f.tx, f.input, f.deps)).result).toMatchObject({ ok: false, code: "internal_error" });
    expect(f.effects()).toBe(0);
  });
  it("rolls back the outer transaction when authority is revoked after Core writes", async () => {
    const f = fixture();
    f.input.revalidate.mockResolvedValueOnce(context).mockResolvedValueOnce({ ...context, isMember: false });
    await expect(f.tx.transaction(tx => invokeReviewedWebsiteDatabaseAction(tx, f.input, f.deps)))
      .rejects.toMatchObject({ code: "permission_revoked" });
    expect(f.effects()).toBe(0);
  });
  it.each(["owner", "session", "scope", "filter"])("rejects changed current %s before invoking", async field => {
    const f = fixture();
    const current = field === "owner" ? { ...context, accountId: actionId } : field === "session"
      ? { ...context, caller: { ...context.caller, credentialId: actionId } } : field === "scope"
      ? { ...context, scopes: [] } : { ...context, isFilter: false };
    f.input.revalidate.mockResolvedValue(current);
    await expect(invokeReviewedWebsiteDatabaseAction(f.tx, f.input, f.deps)).rejects.toMatchObject({ code: "permission_revoked" });
    expect(f.invoke).not.toHaveBeenCalled();
  });
  it("does not invoke when target revalidation rejects or the caller cancels", async () => {
    const f = fixture();
    vi.mocked(f.deps.revalidateProposal).mockRejectedValue(new Error("target_changed"));
    await expect(invokeReviewedWebsiteDatabaseAction(f.tx, f.input, f.deps)).rejects.toThrow("target_changed");
    const controller = new AbortController(); controller.abort();
    await expect(invokeReviewedWebsiteDatabaseAction(f.tx, { ...f.input, signal: controller.signal }, f.deps)).rejects.toThrow();
    expect(f.invoke).not.toHaveBeenCalled();
  });
  it("adds human confirmation only for stored reviewed reports and captures audit data without using the root callback", async () => {
    const f = fixture();
    const reportArgs = { public_content_id: actionId, reason_code: "spam", details: null };
    const report: WebsiteAgentActionProposal = { ...proposal, toolName: "attention_report_content", arguments: reportArgs,
      argumentsHash: websiteAgentActionArgumentsHash("attention_report_content", reportArgs), requiredScopes: ["moderation:write"] };
    const rootAudit = vi.fn();
    const current = { ...context, scopes: ["moderation:write"], recordAudit: rootAudit };
    f.input.revalidate.mockResolvedValue(current);
    const invoke = vi.fn(async (ctx, raw) => {
      expect(raw).toEqual({ ...reportArgs, explicit_confirmation: true });
      ctx.recordAudit(ctx.getDatabase(), { accountId: owner, toolName: report.toolName });
      return { ok: true as const, value: {} };
    });
    f.deps.registry = [{ ...attentionToolRegistry.find(tool => tool.name === report.toolName)!, invoke }];
    const result = await invokeReviewedWebsiteDatabaseAction(f.tx, { ...f.input, context: current, proposal: report }, f.deps);
    expect(result.audits).toEqual([{ accountId: owner, toolName: report.toolName }]);
    expect(rootAudit).not.toHaveBeenCalled();
  });
  it("locks authority in fixed order and rejects missing auth-session ownership", async () => {
    const f = fixture();
    await lockWebsiteAgentActionAuthority(f.tx, { accountId: owner, authSessionId: actionId });
    expect(f.tx.execute).toHaveBeenCalledTimes(7);
    vi.mocked(f.tx.execute).mockReset().mockResolvedValueOnce([{ id: owner }] as never).mockResolvedValueOnce([{ id: owner }] as never)
      .mockResolvedValueOnce([] as never);
    // setAccountContext executes first, then account, then the owned auth session.
    await expect(lockWebsiteAgentActionAuthority(f.tx, { accountId: owner, authSessionId: actionId }))
      .rejects.toMatchObject({ code: "permission_revoked" });
  });
});
