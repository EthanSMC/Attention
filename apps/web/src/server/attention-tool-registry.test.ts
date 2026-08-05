import {
  CollectionRepositoryError,
  type AttentionDatabase,
} from "@attention/db";
import { describe, expect, it, vi } from "vitest";

import { CollectionServiceError } from "./collection-service";
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

function dependencies(
  overrides: Partial<AttentionToolCoreDependencies> = {},
): AttentionToolCoreDependencies {
  return {
    collectFromWeb: vi.fn(),
    getCollectionStatus: vi.fn(),
    loadMyCollections: vi.fn(),
    loadPublicContents: vi.fn(),
    publicFeedPreviewLimit: vi.fn(() => 20),
    retrieveForAgent: vi.fn(),
    selectCandidateFromWeb: vi.fn(),
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
    ).resolves.toMatchObject({ code: "filter_required", ok: false });
  });

  it("enforces the status XOR and forwards only the owner-scoped reference", async () => {
    const getStatus = vi.fn(async () => ({
      attempt: { attempt_id: attemptId, status: "processing" },
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
        attempt: { attempt_id: attemptId, status: "accepted" },
        collection: { collection_id: collectionId },
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
});
