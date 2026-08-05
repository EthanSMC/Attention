import type { AttentionDatabase } from "@attention/db";
import { eventLedger } from "@attention/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ATTENTION_TOOL_AUDIT_EVENT_TYPE,
  recordAttentionToolAuditBestEffort,
} from "./attention-tool-audit";

const accountId = "00000000-0000-4000-8000-000000000001";
const credentialId = "00000000-0000-4000-8000-000000000002";
const attemptId = "00000000-0000-4000-8000-000000000003";
const collectionId = "00000000-0000-4000-8000-000000000004";

function databaseMock(options: { reject?: Error } = {}) {
  const values = options.reject
    ? vi.fn().mockRejectedValue(options.reject)
    : vi.fn().mockResolvedValue(undefined);
  const insert = vi.fn(() => ({ values }));
  const execute = vi.fn().mockResolvedValue(undefined);
  const transaction = vi.fn(async (callback: (tx: unknown) => unknown) =>
    callback({ execute, insert }),
  );
  return {
    db: { transaction } as unknown as AttentionDatabase,
    execute,
    insert,
    transaction,
    values,
  };
}

function validInput() {
  return {
    accountId,
    attemptId,
    clientId: "att_codex_client",
    collectionId,
    contractVersion: "1.0.0",
    credentialId,
    credentialKind: "oauth" as const,
    durationMs: 42.6,
    entrypoint: "hosted_mcp" as const,
    outcome: "tool_error" as const,
    reportedSkillId: "attention" as const,
    reportedSkillVersion: "1.0.0" as const,
    reportedWorkflowId: "att_pat_private-token",
    requestId: "00000000-0000-4000-8000-000000000006",
    resultStatus: "resolution_pending",
    stableErrorCode: "fetch_pending",
    toolName: "attention_collect_content",
  };
}

beforeEach(() => {
  vi.stubEnv(
    "ATTENTION_AUDIT_HMAC_SECRET",
    "attention-audit-test-secret-at-least-32-characters",
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Attention tool audit", () => {
  it("writes only the allowlisted event columns and metadata", async () => {
    const { db, execute, insert, transaction, values } = databaseMock();
    const canaries = {
      authorization: "Bearer audit-secret",
      body: "<html>private page body</html>",
      idempotencyKey: "private-idempotency-key",
      input: "private share text",
      query: "private search query",
      selectionToken: "private-selection-token",
      token: "att_pat_private-token",
      url: "https://example.org/private?access_token=secret",
    };

    await recordAttentionToolAuditBestEffort(db, {
      ...validInput(),
      ...canaries,
    } as Parameters<typeof recordAttentionToolAuditBestEffort>[1]);

    expect(insert).toHaveBeenCalledWith(eventLedger);
    expect(transaction).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    expect(values).toHaveBeenCalledWith({
      accountId,
      eventType: ATTENTION_TOOL_AUDIT_EVENT_TYPE,
      metadata: {
        attempt_id: attemptId,
        client_id: "att_codex_client",
        client_reported_skill_id: "attention",
        client_reported_skill_version: "1.0.0",
        client_reported_workflow_fingerprint:
          expect.stringMatching(/^(?:hmac-)?sha256:[a-f0-9]{64}$/u),
        collection_id: collectionId,
        contract_version: "1.0.0",
        credential_id: credentialId,
        credential_kind: "oauth",
        duration_ms: 43,
        entrypoint: "hosted_mcp",
        outcome: "tool_error",
        result_status: "resolution_pending",
        stable_error_code: "fetch_pending",
        tool_name: "attention_collect_content",
      },
      requestId: "00000000-0000-4000-8000-000000000006",
      scope: "private",
    });
    const persisted = JSON.stringify(values.mock.calls);
    for (const value of Object.values(canaries)) {
      expect(persisted).not.toContain(value);
    }
  });

  it("does not throw or persist an invalid record", async () => {
    const { db, insert } = databaseMock();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(recordAttentionToolAuditBestEffort(db, {
      ...validInput(),
      stableErrorCode: "https://example.org/raw-error?token=secret",
    })).resolves.toBeUndefined();

    expect(insert).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith("attention_tool_audit_invalid");
    expect(JSON.stringify(error.mock.calls)).not.toContain("token=secret");
  });

  it("omits the workflow fingerprint when no HMAC secret is configured", async () => {
    vi.stubEnv("ATTENTION_AUDIT_HMAC_SECRET", "");
    vi.stubEnv("ATTENTION_HMAC_SECRET", "");
    const { db, values } = databaseMock();

    await recordAttentionToolAuditBestEffort(db, validInput());

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          client_reported_workflow_fingerprint: null,
        }),
      }),
    );
  });

  it("does not expose a database failure to the tool caller", async () => {
    const { db } = databaseMock({
      reject: new Error("database failed with att_pat_private-token"),
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      recordAttentionToolAuditBestEffort(db, validInput()),
    ).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledWith("attention_tool_audit_write_failed", {
      name: "Error",
    });
    expect(JSON.stringify(error.mock.calls)).not.toContain("att_pat_private-token");
  });
});
