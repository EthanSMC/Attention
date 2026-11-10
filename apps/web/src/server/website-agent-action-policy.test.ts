import { submitContentReport, type AttentionDatabase } from "@attention/db";
import { describe, expect, it, vi } from "vitest";
import { ATTENTION_TOOL_NAMES, attentionToolRegistry, type AttentionToolContext } from "./attention-tool-registry";
import { parseWebsiteAgentActionProposal, prepareWebsiteAgentAction, revalidateWebsiteAgentAction,
  websiteAgentActionArgumentsHash, websiteAgentToolPolicy, type WebsiteAgentActionPolicyDependencies } from "./website-agent-action-policy";

const owner = "00000000-0000-4000-8000-000000000001";
const target = "00000000-0000-4000-8000-000000000002";
const time = "2026-11-10T00:00:00.000Z";
const context: AttentionToolContext = { accountId: owner, caller: { clientId: "attention-website", credentialId: owner,
  credentialKind: "session", entrypoint: "hosted_agent" }, isMember: true, isFilter: true,
  requestId: owner, runId: "website:test", serviceOrigin: "https://attention.example", signal: new AbortController().signal,
  getDatabase: () => ({} as AttentionDatabase), scopes: ["collection:write", "digest:write", "moderation:write", "moderation:court:vote"] };
function dependencies(): WebsiteAgentActionPolicyDependencies {
  return {
    now: () => new Date(time),
    loadPublicContentVersion: vi.fn(async () => ({ revision: time, sourceFingerprint: "a".repeat(64) })),
    loadDigestDeliveryRecipient: vi.fn(async () => ({ email: "review-recipient@example.test", verified: true })),
    getCollectionStatus: vi.fn<WebsiteAgentActionPolicyDependencies["getCollectionStatus"]>(async () => ({ attempt: null,
      collection: { collected_at: time, collection_id: target, collection_status: "active", effectively_public: false,
        filter_revoked_at: null, moderation_status: "clear", original_url: `/out/mine/${target}`, public_since: null, updated_at: time, visibility: "private" },
      content: { community_moderation_status: "clear", content_id: target, content_status: "active", content_type: "article",
        enrichment_action: "generate_summary", enrichment_status: "pending", public_read_url: "https://example.com/article",
        public_safety_status: "allowed", source: "generic_web", summary_status: "pending", takedown_status: "none", title: "Fixture article", updated_at: time },
    })),
    loadDigestSettings: vi.fn(async () => ({ enabled: true, timezone: "Asia/Shanghai", windowStart: "08:00", windowMinutes: 60,
      domains: [{ slug: "ai", name: "AI", active: true }, { slug: "science", name: "Science", active: false }] })),
    loadPublicContents: vi.fn<WebsiteAgentActionPolicyDependencies["loadPublicContents"]>(async () => [{ id: target, title: "Fixture public article", summary: "Fixture summary", summaryStatus: "ready",
      source: "example.com", sourceInitial: "E", sourceTone: "indigo", author: null, publishedAt: null, firstPublicAt: time,
      tags: [], filters: [], outboundHref: `/out/public/${target}` }]),
    listModerationCourtCases: vi.fn<WebsiteAgentActionPolicyDependencies["listModerationCourtCases"]>(async () => [{ id: target, title: "Fixture case", publicContentId: target, source: "example.com", author: null,
      communityStatus: "pending_review", eligibleFilterCount: 3, hiddenVotes: 0, publicVotes: 1, myVote: null,
      openedAt: new Date(time), votingEndsAt: new Date("2026-11-11T00:00:00.000Z"), status: "open", outboundHref: `/out/court/${target}` }]),
  };
}
const digest = { enabled: true, domain_slugs: ["science", "ai"], timezone: "Asia/Shanghai", window_start: "08:00", window_minutes: 60 };

describe("trusted website action proposals", () => {
  it("classifies all canonical tools, including explicit blocked gates", () => {
    expect(Object.keys(websiteAgentToolPolicy).sort()).toEqual([...ATTENTION_TOOL_NAMES].sort());
    expect(websiteAgentToolPolicy.attention_submit_content_enrichment).toBe("reviewed_action");
    expect(websiteAgentToolPolicy.attention_select_collection_candidate).toBe("candidate_review_required");
  });
  it("binds an owned visibility target and displays the public consequence", async () => {
    const deps = dependencies();
    const proposal = await prepareWebsiteAgentAction(context, "attention_update_collection", { collection_id: target, visibility: "public" }, deps);
    expect(proposal.arguments).toEqual({ collection_id: target, visibility: "public" });
    expect(proposal.review.consequences.join()).toContain("公开收藏者身份");
    expect(deps.getCollectionStatus).toHaveBeenCalledWith({}, context, { collection_id: target });
    expect(parseWebsiteAgentActionProposal(proposal)).toEqual(proposal);
  });
  it("normalizes exact report text without accepting a model confirmation flag", async () => {
    const proposal = await prepareWebsiteAgentAction(context, "attention_report_content", {
      public_content_id: target, reason_code: "SPAM", details: "  Ａ  ",
    }, dependencies());
    expect(proposal.arguments).toEqual({ public_content_id: target, reason_code: "spam", details: "A" });
    expect(proposal.review.consequences.join()).toContain("不能通过本工具撤回");
    expect(proposal.review.details).toContainEqual({ label: "原文链接", value: `https://attention.example/out/public/${target}` });
    await expect(prepareWebsiteAgentAction(context, "attention_report_content", {
      public_content_id: target, reason_code: "spam", explicit_confirmation: true,
    }, dependencies())).rejects.toMatchObject({ code: "action_invalid_proposal" });
  });
  it.each(["9spam", "bad-reason"])("rejects schema-valid but Core-invalid report reason %s before executable review", async reason => {
    const canonical = attentionToolRegistry.find(tool => tool.name === "attention_report_content")!;
    expect(canonical.inputSchema.safeParse({ public_content_id: target, reason_code: reason, explicit_confirmation: true }).success).toBe(true);
    await expect(submitContentReport({} as AttentionDatabase, { accountId: owner, publicContentId: target, reasonCode: reason }))
      .rejects.toMatchObject({ code: "invalid_report" });
    await expect(prepareWebsiteAgentAction(context, canonical.name, { public_content_id: target, reason_code: reason }, dependencies()))
      .rejects.toMatchObject({ code: "action_invalid_proposal" });
  });
  it("rejects an approval if the public source changed behind the same display route", async () => {
    const deps = dependencies();
    const proposal = await prepareWebsiteAgentAction(context, "attention_report_content", {
      public_content_id: target, reason_code: "spam",
    }, deps);
    vi.mocked(deps.loadPublicContentVersion).mockResolvedValue({ revision: time, sourceFingerprint: "b".repeat(64) });
    await expect(revalidateWebsiteAgentAction(context, proposal, deps)).rejects.toMatchObject({ code: "action_target_changed" });
  });
  it("discloses irreversible voting and rejects another decision after a vote", async () => {
    const deps = dependencies();
    const proposal = await prepareWebsiteAgentAction(context, "attention_cast_moderation_vote", { case_id: target, decision: "hidden" }, deps);
    expect(proposal.review.consequences.join()).toContain("不可更改或撤回");
    expect(proposal.review.details).toContainEqual({ label: "原文链接", value: `https://attention.example/out/court/${target}` });
    const rows = await deps.listModerationCourtCases({} as AttentionDatabase, { accountId: owner });
    vi.mocked(deps.listModerationCourtCases).mockResolvedValue([{ ...rows[0]!, myVote: "public" }]);
    await expect(prepareWebsiteAgentAction(context, proposal.toolName, proposal.arguments, deps)).rejects.toMatchObject({ code: "action_target_unavailable" });
  });
  it("normalizes domain order and discloses recurring digest delivery", async () => {
    const proposal = await prepareWebsiteAgentAction(context, "attention_update_digest_settings", digest, dependencies());
    expect(proposal.arguments.domain_slugs).toEqual(["ai", "science"]);
    expect(proposal.review.consequences.join()).toContain("持续发送摘要");
    expect(proposal.review.details).toContainEqual({ label: "收件邮箱", value: "review-recipient@example.test" });
    expect(parseWebsiteAgentActionProposal(proposal)).toEqual(proposal);
  });
  it("binds the actual digest recipient and rejects an account email change before approval", async () => {
    const deps = dependencies();
    const proposal = await prepareWebsiteAgentAction(context, "attention_update_digest_settings", digest, deps);
    expect(deps.loadDigestDeliveryRecipient).toHaveBeenCalledWith({}, owner);
    expect(proposal.arguments).not.toHaveProperty("email");
    vi.mocked(deps.loadDigestDeliveryRecipient).mockResolvedValue({ email: "new-recipient@example.test", verified: true });
    await expect(revalidateWebsiteAgentAction(context, proposal, deps)).rejects.toMatchObject({ code: "action_target_changed" });
  });
  it.each([{ email: null, verified: false }, { email: "unverified@example.test", verified: false }])(
    "does not enable recurring delivery without a verified actual recipient: %s", async recipient => {
      const deps = dependencies(); vi.mocked(deps.loadDigestDeliveryRecipient).mockResolvedValue(recipient);
      await expect(prepareWebsiteAgentAction(context, "attention_update_digest_settings", digest, deps))
        .rejects.toMatchObject({ code: "action_delivery_recipient_required" });
      await expect(prepareWebsiteAgentAction(context, "attention_update_digest_settings", { ...digest, enabled: false }, deps))
        .resolves.toMatchObject({ arguments: { enabled: false } });
    });
  it.each([{ timezone: "Bad/Zone" }, { domain_slugs: ["ai", "ai"] }, { window_start: "23:59", window_minutes: 60 }])(
    "rejects invalid digest settings before Core writes: %s", async change => {
      await expect(prepareWebsiteAgentAction(context, "attention_update_digest_settings", { ...digest, ...change }, dependencies()))
        .rejects.toMatchObject({ code: "action_invalid_proposal" });
    });
  it.each(["made_up"])(
    "never creates executable proposals for gated tool %s", async name => {
      await expect(prepareWebsiteAgentAction(context, name, {}, dependencies())).rejects.toMatchObject({ code: "action_not_supported" });
    });
  it("rechecks live Filter authority and required scope", async () => {
    for (const current of [{ ...context, isFilter: false }, { ...context, scopes: [] }, { ...context, isMember: false }]) {
      await expect(prepareWebsiteAgentAction(current, "attention_update_collection", { collection_id: target, visibility: "public" }, dependencies()))
        .rejects.toMatchObject({ code: "permission_revoked" });
    }
  });
  it("detects target changes and contract changes before approval", async () => {
    const deps = dependencies();
    const proposal = await prepareWebsiteAgentAction(context, "attention_update_digest_settings", digest, deps);
    await expect(revalidateWebsiteAgentAction(context, proposal, deps)).resolves.toBeUndefined();
    vi.mocked(deps.loadDigestSettings).mockResolvedValue({ enabled: false, timezone: "UTC", windowStart: "09:00", windowMinutes: 60, domains: [] });
    await expect(revalidateWebsiteAgentAction(context, proposal, deps)).rejects.toMatchObject({ code: "action_target_unavailable" });
    const previous = { ...proposal, contractVersion: "1.0.0", argumentsHash: websiteAgentActionArgumentsHash(proposal.toolName, proposal.arguments, "1.0.0") };
    expect(parseWebsiteAgentActionProposal(previous).contractVersion).toBe("1.0.0");
    await expect(revalidateWebsiteAgentAction(context, previous, dependencies())).rejects.toMatchObject({ code: "action_contract_changed" });
  });
  it("purely rejects forged arguments, review overflow, scopes, extra keys and hashes", async () => {
    const deps = dependencies();
    const proposal = await prepareWebsiteAgentAction(context, "attention_update_digest_settings", digest, deps);
    vi.clearAllMocks();
    for (const forged of [
      { ...proposal, arguments: { ...proposal.arguments, enabled: false } },
      { ...proposal, argumentsHash: "a".repeat(64) }, { ...proposal, requiredScopes: ["moderation:write"] },
      { ...proposal, review: { ...proposal.review, title: "x".repeat(201) } },
      { ...proposal, owner: target }, { ...proposal, arguments: { ...proposal.arguments, client_context: {} } },
    ]) expect(() => parseWebsiteAgentActionProposal(forged)).toThrow();
    expect(deps.loadDigestSettings).not.toHaveBeenCalled();
  });
});
