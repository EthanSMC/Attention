import {
  AttentionToolSuccessOutputSchemas,
} from "@attention/contracts";
import {
  CollectionRepositoryError,
  ModerationRepositoryError,
  type AttentionDatabase,
} from "@attention/db";
import { describe, expect, it, vi } from "vitest";

import type { CollectionItem } from "../lib/attention";
import { AgentAccessError } from "./agent-retrieval";
import { CollectionServiceError } from "./collection-service";
import { ContentEnrichmentServiceError } from "./content-enrichment-service";
import { DigestSettingsError } from "./digest-settings";
import {
  createAttentionToolRegistry,
  type AttentionToolContext,
  type AttentionToolCoreDependencies,
  type AttentionToolName,
} from "./attention-tool-registry";

const accountId = "00000000-0000-4000-8000-000000000001";
const credentialId = "00000000-0000-4000-8000-000000000002";
const requestId = "00000000-0000-4000-8000-000000000003";
const attemptId = "00000000-0000-4000-8000-000000000004";
const collectionId = "00000000-0000-4000-8000-000000000005";
const moderationCaseId = "00000000-0000-4000-8000-000000000006";
const moderationVoteId = "00000000-0000-4000-8000-000000000007";
const statusTimestamp = "2026-08-07T00:00:00.000Z";

function attemptStatus(
  status: "accepted" | "processing",
) {
  return {
    attempt_id: attemptId,
    error_code: null,
    next_action: status === "processing" ? "wait" as const : "none" as const,
    received_at: statusTimestamp,
    retry_after_seconds: status === "processing" ? 15 : null,
    selection_expires_at: null,
    status,
    updated_at: statusTimestamp,
  };
}

function ownedCollectionStatus() {
  return {
    collected_at: statusTimestamp,
    collection_id: collectionId,
    collection_status: "active" as const,
    effectively_public: false,
    filter_revoked_at: null,
    moderation_status: "clear" as const,
    original_url: `/out/mine/${collectionId}`,
    public_since: null,
    updated_at: statusTimestamp,
    visibility: "private" as const,
  };
}

function dependencies(
  overrides: Partial<AttentionToolCoreDependencies> = {},
): AttentionToolCoreDependencies {
  return {
    castModerationVote: vi.fn(),
    collectFromWeb: vi.fn(),
    getCollectionStatus: vi.fn(),
    loadAccountOverview: vi.fn(),
    loadCurrentSubscription: vi.fn(),
    loadDigestSettings: vi.fn(),
    listModerationCourtCases: vi.fn(),
    loadMyCollections: vi.fn(),
    loadPublicContents: vi.fn(),
    publicFeedPreviewLimit: vi.fn(() => 20),
    reportPublicContent: vi.fn(),
    retrieveForAgent: vi.fn(),
    selectCandidateFromWeb: vi.fn(),
    submitContentEnrichment: vi.fn(),
    updateDigestSettings: vi.fn(),
    updateCollectionVisibility: vi.fn(),
    ...overrides,
  } as unknown as AttentionToolCoreDependencies;
}

function context(
  overrides: Partial<AttentionToolContext> = {},
): AttentionToolContext {
  return {
    accountId,
    caller: {
      clientId: "attention-codex",
      credentialId,
      credentialKind: "oauth",
      entrypoint: "hosted_mcp",
    },
    getDatabase: () => ({} as AttentionDatabase),
    isFilter: false,
    isMember: false,
    requestId,
    runId: `${requestId}:1`,
    serviceOrigin: "https://attention.example",
    scopes: [],
    signal: new AbortController().signal,
    ...overrides,
  };
}

function tool(
  core: AttentionToolCoreDependencies,
  name: AttentionToolName,
) {
  const definition = createAttentionToolRegistry(core).find(
    (item) => item.name === name,
  );
  if (!definition) throw new Error(`Missing tool ${name}`);
  return definition;
}

describe("Attention Tool Registry execution contract", () => {
  it("binds every public tool name to exactly one success output schema", () => {
    expect(Object.keys(AttentionToolSuccessOutputSchemas)).toEqual(
      createAttentionToolRegistry(dependencies()).map((definition) => definition.name),
    );
  });

  it("submits validated shared enrichment with collection write scope", async () => {
    const core = dependencies({
      submitContentEnrichment: vi.fn(async () => ({
        contentId: collectionId,
        status: "enriched" as const,
        summaryStatus: "ready" as const,
      })),
    });

    await expect(
      tool(core, "attention_submit_content_enrichment").invoke(
        context({ scopes: ["collection:write"] }),
        {
          content_id: collectionId,
          idempotency_key: "enrichment-request-1",
          summary: "A grounded summary.",
          tags: ["Agents", "agents", "  MCP  "],
        },
      ),
    ).resolves.toEqual({
      ok: true,
      value: {
        content_id: collectionId,
        status: "enriched",
        summary_status: "ready",
      },
    });
    expect(core.submitContentEnrichment).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ accountId }),
      {
        content_id: collectionId,
        idempotency_key: "enrichment-request-1",
        summary: "A grounded summary.",
        tags: ["Agents", "agents", "MCP"],
      },
    );
  });

  it("returns a stable non-retryable error for terminal summary Content", async () => {
    const core = dependencies({
      submitContentEnrichment: vi.fn(async () => {
        throw new ContentEnrichmentServiceError(
          "content_enrichment_unavailable",
          409,
        );
      }),
    });

    await expect(
      tool(core, "attention_submit_content_enrichment").invoke(
        context({ scopes: ["collection:write"] }),
        {
          content_id: collectionId,
          idempotency_key: "terminal-enrichment-1",
          summary: "This must not replace a terminal result.",
          tags: ["terminal"],
        },
      ),
    ).resolves.toEqual({
      code: "content_enrichment_unavailable",
      guidance:
        "This Content has a terminal summary result and cannot be regenerated.",
      ok: false,
    });
  });

  it("exposes only public profile fields and live capabilities", async () => {
    const core = dependencies({
      loadAccountOverview: vi.fn(async () => ({
        attentionId: "ethancc",
        attentionIdChangedAt: null,
        avatarUrl: "data:image/webp;base64,private-avatar-bytes",
        displayName: "Ethan",
        email: "private@example.com",
        hasPassword: true,
      })),
    });

    await expect(
      tool(core, "attention_get_my_account").invoke(
        context({
          isFilter: true,
          isMember: true,
          scopes: ["profile:read"],
        }),
        {},
      ),
    ).resolves.toEqual({
      ok: true,
      value: {
        capabilities: { is_filter: true, is_member: true },
        profile: {
          attention_id: "ethancc",
          display_name: "Ethan",
          has_avatar: true,
        },
      },
    });
  });

  it("turns a Core output drift into an internal error instead of blaming input", async () => {
    const core = dependencies({
      loadAccountOverview: vi.fn(async () => ({
        attentionId: "not valid",
        attentionIdChangedAt: null,
        avatarUrl: null,
        displayName: "Ethan",
        email: null,
        hasPassword: false,
      })),
    });

    await expect(
      tool(core, "attention_get_my_account").invoke(
        context({ scopes: ["profile:read"] }),
        {},
      ),
    ).resolves.toMatchObject({ code: "internal_error", ok: false });
  });

  it("reads membership state without exposing a billing mutation", async () => {
    const currentPeriodEnd = new Date("2027-08-07T00:00:00.000Z");
    const core = dependencies({
      loadCurrentSubscription: vi.fn(async () => ({
        cancelAtPeriodEnd: false,
        currentPeriodEnd,
        status: "active" as const,
      })),
    });

    await expect(
      tool(core, "attention_get_membership_status").invoke(
        context({ isMember: true, scopes: ["subscription:read"] }),
        {},
      ),
    ).resolves.toEqual({
      ok: true,
      value: {
        capabilities: { is_filter: false, is_member: true },
        subscription: {
          cancel_at_period_end: false,
          current_period_end: currentPeriodEnd.toISOString(),
          status: "active",
        },
      },
    });
  });

  it("requires the matching read scopes for account and membership tools", async () => {
    const core = dependencies();

    await expect(
      tool(core, "attention_get_my_account").invoke(context(), {}),
    ).resolves.toMatchObject({
      code: "insufficient_scope",
      ok: false,
      requiredScope: "profile:read",
    });
    await expect(
      tool(core, "attention_get_membership_status").invoke(context(), {}),
    ).resolves.toMatchObject({
      code: "insufficient_scope",
      ok: false,
      requiredScope: "subscription:read",
    });
    expect(core.loadAccountOverview).not.toHaveBeenCalled();
    expect(core.loadCurrentSubscription).not.toHaveBeenCalled();
  });

  it("projects the Web collection-card fields into structured MCP results", async () => {
    const core = dependencies({
      loadMyCollections: vi.fn(async () => [
        {
          author: "Author",
          collectedAt: "2026-08-07T00:00:00.000Z",
          effectiveVisibility: "public",
          filters: [
            {
              attentionId: "ethancc",
              displayName: "Ethan",
              initials: "E",
            },
          ],
          firstPublicAt: "2026-08-07T00:00:00.000Z",
          id: collectionId,
          outboundHref: `/out/mine/${collectionId}`,
          publishedAt: "2026-08-06",
          source: "example.org",
          sourceInitial: "E",
          sourceTone: "gold",
          summary: "Summary",
          summaryStatus: "ready",
          tags: ["agents"],
          title: "Title",
          visibility: "public",
        } satisfies CollectionItem,
      ]),
    });

    await expect(
      tool(core, "attention_list_collections").invoke(
        context({ scopes: ["collection:read"] }),
        {},
      ),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        items: [
          {
            effective_visibility: "public",
            filters: [
              { attention_id: "ethancc", display_name: "Ethan" },
            ],
            published_at: "2026-08-06",
            original_url: `https://attention.example/out/mine/${collectionId}`,
            summary_status: "ready",
            tags: ["agents"],
          },
        ],
      },
    });
  });

  it("requires a stable collect idempotency key before calling Core", async () => {
    const core = dependencies();

    await expect(
      tool(core, "attention_collect_content").invoke(
        context({ scopes: ["collection:write"] }),
        { input: "https://example.org/article", visibility: "private" },
      ),
    ).resolves.toEqual({
      code: "invalid_request",
      guidance: "Check the tool input and try again.",
      ok: false,
    });
    expect(core.collectFromWeb).not.toHaveBeenCalled();
  });

  it("maps one-time candidate failures to stable public errors", async () => {
    const core = dependencies({
      selectCandidateFromWeb: vi.fn(async () => {
        throw new CollectionServiceError("selection_expired", 409);
      }),
    });

    await expect(
      tool(core, "attention_select_collection_candidate").invoke(
        context({ scopes: ["collection:write"] }),
        {
          candidate_id: collectionId,
          selection_token: "s".repeat(32),
          visibility: "private",
        },
      ),
    ).resolves.toEqual({
      code: "selection_expired",
      guidance: "Submit the original content again to get a new selection token.",
      ok: false,
    });
  });

  it("maps a live repository Filter revocation to filter_required", async () => {
    const core = dependencies({
      collectFromWeb: vi.fn(async () => {
        throw new CollectionRepositoryError("public_requires_filter");
      }),
    });

    await expect(
      tool(core, "attention_collect_content").invoke(
        context({
          isFilter: true,
          scopes: ["collection:write"],
        }),
        {
          idempotency_key: "stable-request-1",
          input: "https://example.org/article",
          visibility: "public",
        },
      ),
    ).resolves.toMatchObject({
      code: "filter_required",
      ok: false,
      requiredEntitlement: "filter",
    });
  });

  it("maps a live Member revocation to actionable entitlement metadata", async () => {
    const core = dependencies({
      retrieveForAgent: vi.fn(async () => {
        throw new AgentAccessError();
      }),
    });

    await expect(
      tool(core, "attention_search_content").invoke(
        context({ isMember: true, scopes: ["ai:search"] }),
        { query: "agent memory" },
      ),
    ).resolves.toEqual({
      code: "membership_required",
      guidance: "Upgrade to Member and reconnect before using AI search.",
      ok: false,
      requiredEntitlement: "member",
    });
  });

  it("rechecks ai:search inside invoke instead of trusting tool discovery", async () => {
    const core = dependencies();

    await expect(
      tool(core, "attention_search_content").invoke(
        context({ isMember: true, scopes: [] }),
        { query: "agent memory" },
      ),
    ).resolves.toMatchObject({
      code: "insufficient_scope",
      ok: false,
      requiredScope: "ai:search",
    });
    expect(core.retrieveForAgent).not.toHaveBeenCalled();
  });

  it("audits only public citations returned by MCP search", async () => {
    const publicId = "00000000-0000-4000-8000-000000000008";
    const privateCollectionId = "00000000-0000-4000-8000-000000000009";
    const recordAudit = vi.fn(async () => undefined);
    const core = dependencies({
      retrieveForAgent: vi.fn(async () => ({
        answer: "Two sources were found.",
        citations: [
          {
            author: null,
            href: `/out/public/${publicId}`,
            id: publicId,
            scope: "public" as const,
            source: "example.com",
            title: "Public source",
          },
          {
            author: null,
            href: `/out/mine/${privateCollectionId}`,
            id: privateCollectionId,
            scope: "mine" as const,
            source: "example.com",
            title: "Private source",
          },
        ],
        mode: "deterministic" as const,
      })),
    });

    await tool(core, "attention_search_content").invoke(
      context({
        isMember: true,
        recordAudit,
        scopes: ["ai:search"],
      }),
      {
        client_context: {
          skill_id: "attention",
          skill_version: "1.3.0",
          workflow_run_id: "workflow-search-1",
        },
        query: "agent memory",
      },
    );

    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        entitlementTier: "member",
        protocolRequestId: `${requestId}:1`,
        publicCitationIds: [publicId],
        toolName: "attention_search_content",
      }),
    );
    expect(JSON.stringify(recordAudit.mock.calls)).not.toContain(
      privateCollectionId,
    );
  });

  it("enforces the status XOR and forwards only the owner-scoped reference", async () => {
    const getStatus = vi.fn(async () => ({
      attempt: attemptStatus("processing"),
      collection: null,
      content: null,
    }));
    const core = dependencies({
      getCollectionStatus:
        getStatus as unknown as AttentionToolCoreDependencies["getCollectionStatus"],
    });
    const definition = tool(core, "attention_get_collection_status");
    const toolContext = context({ scopes: ["collection:read"] });

    await expect(
      definition.invoke(toolContext, {
        attempt_id: attemptId,
        collection_id: collectionId,
      }),
    ).resolves.toMatchObject({ code: "invalid_request", ok: false });
    await expect(
      definition.invoke(toolContext, {
        attempt_id: attemptId,
        client_context: {
          skill_id: "attention",
          skill_version: "1.0.0",
          workflow_run_id: "workflow-1",
        },
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(getStatus).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ accountId }),
      { attempt_id: attemptId },
    );
  });

  it("records only allowlisted client context and result references", async () => {
    const recordAudit = vi.fn(async () => undefined);
    const core = dependencies({
      getCollectionStatus: vi.fn(async () => ({
        attempt: attemptStatus("accepted"),
        collection: ownedCollectionStatus(),
        content: null,
      })) as unknown as AttentionToolCoreDependencies["getCollectionStatus"],
    });

    await tool(core, "attention_get_collection_status").invoke(
      context({ recordAudit, scopes: ["collection:read"] }),
      {
        attempt_id: attemptId,
        client_context: {
          skill_id: "attention",
          skill_version: "1.0.0",
          workflow_run_id: "workflow-1",
        },
      },
    );

    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        accountId,
        attemptId,
        collectionId,
        reportedSkillId: "attention",
        reportedSkillVersion: "1.0.0",
        reportedWorkflowId: "workflow-1",
        resultStatus: "accepted",
        stableErrorCode: null,
        toolName: "attention_get_collection_status",
      }),
    );
    const serialized = JSON.stringify(recordAudit.mock.calls);
    expect(serialized).not.toContain("client_context");
  });

  it("rechecks Filter capability before making a collection public", async () => {
    const core = dependencies();

    await expect(
      tool(core, "attention_update_collection").invoke(
        context({ scopes: ["collection:write"] }),
        { collection_id: collectionId, visibility: "public" },
      ),
    ).resolves.toMatchObject({ code: "filter_required", ok: false });
    expect(core.updateCollectionVisibility).not.toHaveBeenCalled();
  });

  it("reports public content through the same moderation Core policy", async () => {
    const reportPublicContent = vi.fn(async () => ({
      caseId: null,
      caseOpened: false,
      communityStatus: "clear" as const,
      duplicate: false,
      reportId: "00000000-0000-4000-8000-000000000006",
    }));
    const core = dependencies({ reportPublicContent });

    await expect(
      tool(core, "attention_report_content").invoke(
        context({ scopes: ["moderation:write"] }),
        {
          explicit_confirmation: true,
          public_content_id: collectionId,
          reason_code: "spam",
        },
      ),
    ).resolves.toMatchObject({
      ok: true,
      value: { case_opened: false, duplicate: false },
    });
    expect(reportPublicContent).toHaveBeenCalledWith(
      expect.anything(),
      accountId,
      {
        details: null,
        publicContentId: collectionId,
        reasonCode: "spam",
      },
    );
  });

  it("does not report content without explicit current-turn confirmation", async () => {
    const reportPublicContent = vi.fn();
    const definition = tool(
      dependencies({ reportPublicContent }),
      "attention_report_content",
    );
    const toolContext = context({ scopes: ["moderation:write"] });

    await expect(
      definition.invoke(toolContext, {
        public_content_id: collectionId,
        reason_code: "spam",
      }),
    ).resolves.toMatchObject({ code: "invalid_request", ok: false });
    await expect(
      definition.invoke(toolContext, {
        explicit_confirmation: false,
        public_content_id: collectionId,
        reason_code: "spam",
      }),
    ).resolves.toMatchObject({ code: "invalid_request", ok: false });
    expect(reportPublicContent).not.toHaveBeenCalled();
  });

  it("preserves the moderation retry window as structured error metadata", async () => {
    const core = dependencies({
      reportPublicContent: vi.fn(async () => {
        throw new ModerationRepositoryError("report_rate_limited", {
          retryAfterSeconds: 321,
        });
      }),
    });

    await expect(
      tool(core, "attention_report_content").invoke(
        context({ scopes: ["moderation:write"] }),
        {
          explicit_confirmation: true,
          public_content_id: collectionId,
          reason_code: "spam",
        },
      ),
    ).resolves.toEqual({
      code: "report_rate_limited",
      guidance: "Wait before opening another moderation case.",
      ok: false,
      retryAfterSeconds: 321,
    });
  });

  it("lists the current Filter court cases through the shared repository", async () => {
    const openedAt = new Date("2026-08-07T00:00:00.000Z");
    const votingEndsAt = new Date("2026-08-08T00:00:00.000Z");
    const listModerationCourtCases = vi.fn(async () => [
      {
        author: "Author",
        communityStatus: "pending_review" as const,
        eligibleFilterCount: 4,
        hiddenVotes: 1,
        id: moderationCaseId,
        myVote: null,
        openedAt,
        outboundHref: `/out/court/${moderationCaseId}`,
        publicContentId: collectionId,
        publicVotes: 2,
        source: "example.org",
        status: "open" as const,
        title: "Review me",
        votingEndsAt,
      },
    ]);
    const core = dependencies({ listModerationCourtCases });

    await expect(
      tool(core, "attention_list_moderation_cases").invoke(
        context({
          isFilter: true,
          scopes: ["moderation:court:read"],
        }),
        {},
      ),
    ).resolves.toEqual({
      ok: true,
      value: {
        cases: [
          {
            author: "Author",
            community_status: "pending_review",
            eligible_filter_count: 4,
            hidden_votes: 1,
            id: moderationCaseId,
            my_vote: null,
            opened_at: openedAt.toISOString(),
            original_url: `https://attention.example/out/court/${moderationCaseId}`,
            public_content_id: collectionId,
            public_votes: 2,
            source: "example.org",
            status: "open",
            title: "Review me",
            voting_ends_at: votingEndsAt.toISOString(),
          },
        ],
        count: 1,
        has_more: false,
        next_offset: null,
        offset: 0,
        total_count: 1,
      },
    });
    expect(listModerationCourtCases).toHaveBeenCalledWith(
      expect.anything(),
      { accountId },
    );
  });

  it("requires an explicit current user confirmation before a court vote", async () => {
    const castModerationVote = vi.fn(async () => ({
      duplicate: false,
      voteId: moderationVoteId,
    }));
    const core = dependencies({ castModerationVote });
    const definition = tool(core, "attention_cast_moderation_vote");
    const toolContext = context({
      isFilter: true,
      scopes: ["moderation:court:vote"],
    });

    await expect(
      definition.invoke(toolContext, {
        case_id: moderationCaseId,
        decision: "public",
      }),
    ).resolves.toMatchObject({ code: "invalid_request", ok: false });
    await expect(
      definition.invoke(toolContext, {
        case_id: moderationCaseId,
        decision: "public",
        explicit_confirmation: false,
      }),
    ).resolves.toMatchObject({ code: "invalid_request", ok: false });
    expect(castModerationVote).not.toHaveBeenCalled();

    await expect(
      definition.invoke(toolContext, {
        case_id: moderationCaseId,
        decision: "public",
        explicit_confirmation: true,
      }),
    ).resolves.toEqual({
      ok: true,
      value: {
        case_id: moderationCaseId,
        decision: "public",
        duplicate: false,
        vote_id: moderationVoteId,
      },
    });
    expect(castModerationVote).toHaveBeenCalledWith(expect.anything(), {
      accountId,
      caseId: moderationCaseId,
      decision: "public",
    });
  });

  it("preserves one-vote and stale-round errors from the court repository", async () => {
    const castModerationVote = vi
      .fn()
      .mockRejectedValueOnce(
        new ModerationRepositoryError("vote_already_cast"),
      )
      .mockRejectedValueOnce(new ModerationRepositoryError("case_not_open"));
    const core = dependencies({ castModerationVote });
    const definition = tool(core, "attention_cast_moderation_vote");
    const toolContext = context({
      isFilter: true,
      scopes: ["moderation:court:vote"],
    });
    const input = {
      case_id: moderationCaseId,
      decision: "hidden" as const,
      explicit_confirmation: true as const,
    };

    await expect(definition.invoke(toolContext, input)).resolves.toEqual({
      code: "vote_already_cast",
      guidance:
        "This Filter already voted in the current case and the decision cannot be changed.",
      ok: false,
    });
    await expect(definition.invoke(toolContext, input)).resolves.toEqual({
      code: "case_not_open",
      guidance:
        "Refresh the moderation case list; this voting round is no longer open.",
      ok: false,
    });
  });

  it("preserves stable moderation and digest service errors", async () => {
    const core = dependencies({
      reportPublicContent: vi.fn(async () => {
        throw new ModerationRepositoryError("content_not_reportable");
      }),
      updateDigestSettings: vi.fn(async () => {
        throw new DigestSettingsError("digest_entitlement_required");
      }),
    });

    await expect(
      tool(core, "attention_report_content").invoke(
        context({ scopes: ["moderation:write"] }),
        {
          explicit_confirmation: true,
          public_content_id: collectionId,
          reason_code: "spam",
        },
      ),
    ).resolves.toMatchObject({ code: "content_not_reportable", ok: false });
    await expect(
      tool(core, "attention_update_digest_settings").invoke(
        context({ scopes: ["digest:write"] }),
        {
          domain_slugs: ["ai"],
          enabled: true,
          timezone: "Asia/Shanghai",
          window_minutes: 60,
          window_start: "08:00",
        },
      ),
    ).resolves.toMatchObject({
      code: "digest_entitlement_required",
      ok: false,
      requiredEntitlement: "member_or_filter",
    });
  });

  it("reads and updates digest settings with distinct scopes", async () => {
    const settings = {
      domains: [{ active: true, name: "AI", slug: "ai" }],
      enabled: true,
      timezone: "Asia/Shanghai",
      windowMinutes: 60,
      windowStart: "08:00",
    };
    const core = dependencies({
      loadDigestSettings: vi.fn(async () => settings),
      updateDigestSettings: vi.fn(async () => settings),
    });

    await expect(
      tool(core, "attention_get_digest_settings").invoke(
        context({ isMember: true, scopes: ["digest:read"] }),
        {},
      ),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        eligible: true,
        settings: { window_minutes: 60, window_start: "08:00" },
      },
    });
    await expect(
      tool(core, "attention_update_digest_settings").invoke(
        context({ isMember: true, scopes: ["digest:write"] }),
        {
          domain_slugs: ["ai"],
          enabled: true,
          timezone: "Asia/Shanghai",
          window_minutes: 60,
          window_start: "08:00",
        },
      ),
    ).resolves.toMatchObject({ ok: true });
  });
});
