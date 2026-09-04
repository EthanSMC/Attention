import "server-only";

import { createHash, createHmac } from "node:crypto";

import {
  eventLedger,
  inArray,
  publicContentsCurrent,
  setAccountContext,
  type AttentionDatabase,
} from "@attention/db";
import { z } from "zod";

export const ATTENTION_TOOL_AUDIT_EVENT_TYPE = "agent.tool_call.v1";
export const MCP_RETRIEVAL_EVENT_TYPE = "mcp_retrieval";

const opaqueIdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const stableCodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[a-z][a-z0-9_]*$/u);
const toolNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^attention_[a-z][a-z0-9_]*$/u);

const attentionToolAuditInputSchema = z
  .object({
    accountId: z.string().uuid(),
    attemptId: z.string().uuid().nullish(),
    clientId: opaqueIdentifierSchema.nullish(),
    collectionId: z.string().uuid().nullish(),
    contentId: z.string().uuid().nullish(),
    contractVersion: opaqueIdentifierSchema,
    credentialId: z.string().uuid(),
    credentialKind: z.enum(["oauth", "pat"]),
    durationMs: z.number().finite().nonnegative().max(86_400_000),
    entitlementTier: z.enum(["free", "member", "filter"]),
    entrypoint: z.enum(["hosted_agent", "hosted_mcp"]),
    outcome: z.enum(["success", "tool_error", "internal_error", "cancelled"]),
    protocolRequestId: opaqueIdentifierSchema.nullish(),
    publicCitationIds: z.array(z.string().uuid()).max(8).default([]),
    reportedSkillId: z.literal("attention").nullish(),
    reportedSkillVersion: z
      .enum(["1.0.0", "1.1.0", "1.2.0", "1.3.0", "1.4.0", "1.5.0", "1.6.0", "1.7.0", "1.8.0", "1.9.0"])
      .nullish(),
    reportedWorkflowId: opaqueIdentifierSchema.nullish(),
    requestId: opaqueIdentifierSchema,
    resultStatus: stableCodeSchema.nullish(),
    stableErrorCode: stableCodeSchema.nullish(),
    toolName: toolNameSchema,
  })
  .strip();

export type AttentionToolAuditInput = z.input<
  typeof attentionToolAuditInputSchema
>;

function auditMetadata(
  input: z.output<typeof attentionToolAuditInputSchema>,
): Record<string, unknown> {
  return {
    attempt_id: input.attemptId ?? null,
    client_id: input.clientId ?? null,
    client_reported_skill_id: input.reportedSkillId ?? null,
    client_reported_skill_version: input.reportedSkillVersion ?? null,
    client_reported_workflow_fingerprint: input.reportedWorkflowId
      ? workflowFingerprint(input.reportedWorkflowId)
      : null,
    collection_id: input.collectionId ?? null,
    content_id: input.contentId ?? null,
    contract_version: input.contractVersion,
    credential_id: input.credentialId,
    credential_kind: input.credentialKind,
    duration_ms: Math.round(input.durationMs),
    entrypoint: input.entrypoint,
    outcome: input.outcome,
    result_status: input.resultStatus ?? null,
    stable_error_code: input.stableErrorCode ?? null,
    tool_name: input.toolName,
  };
}

function retrievalDedupeKey(
  input: z.output<typeof attentionToolAuditInputSchema>,
  contentId: string,
): string {
  const clientNamespace = input.clientId ?? input.credentialId;
  const requestNamespace =
    input.reportedWorkflowId && input.protocolRequestId
      ? `${input.reportedWorkflowId}\0${input.protocolRequestId}`
      : input.requestId;
  const digest = createHash("sha256")
    .update("attention:mcp-retrieval:v1\0")
    .update(input.accountId)
    .update("\0")
    .update(clientNamespace)
    .update("\0")
    .update(requestNamespace)
    .update("\0")
    .update(contentId)
    .digest("hex");
  return `mcp-retrieval-v1:${digest}`;
}

function retrievalMetadata(
  input: z.output<typeof attentionToolAuditInputSchema>,
): Record<string, unknown> {
  return {
    client_id: input.clientId ?? null,
    credential_id: input.credentialId,
    credential_kind: input.credentialKind,
    entitlement_tier: input.entitlementTier,
    entrypoint: input.entrypoint,
    tool_name: input.toolName,
  };
}

function workflowFingerprint(value: string): string | null {
  const payload = `attention:tool-workflow:v1\0${value}`;
  const secret =
    process.env.ATTENTION_AUDIT_HMAC_SECRET?.trim() ||
    process.env.ATTENTION_HMAC_SECRET?.trim();
  if (secret && secret.length >= 32) {
    return `hmac-sha256:${createHmac("sha256", secret).update(payload).digest("hex")}`;
  }
  return null;
}

/**
 * Record allowlisted tool telemetry without making audit availability part of
 * the tool's business result. Invalid records and database failures are logged
 * without their values and otherwise ignored.
 */
export async function recordAttentionToolAuditBestEffort(
  db: AttentionDatabase,
  rawInput: AttentionToolAuditInput,
): Promise<void> {
  const parsed = attentionToolAuditInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    console.error("attention_tool_audit_invalid");
    return;
  }

  try {
    await db.transaction(async (tx) => {
      await setAccountContext(tx, parsed.data.accountId);
      await tx.insert(eventLedger).values({
        accountId: parsed.data.accountId,
        eventType: ATTENTION_TOOL_AUDIT_EVENT_TYPE,
        metadata: auditMetadata(parsed.data),
        requestId: parsed.data.requestId,
        scope: "private",
      });
      if (
        parsed.data.entrypoint !== "hosted_mcp" ||
        parsed.data.outcome !== "success" ||
        parsed.data.toolName !== "attention_search_content" ||
        parsed.data.publicCitationIds.length === 0
      ) {
        return;
      }
      const publicRows = await tx
        .select({
          contentId: publicContentsCurrent.id,
          publicId: publicContentsCurrent.publicId,
        })
        .from(publicContentsCurrent)
        .where(
          inArray(
            publicContentsCurrent.publicId,
            parsed.data.publicCitationIds,
          ),
        );
      const byContent = new Map(
        publicRows.map((row) => [row.contentId, row] as const),
      );
      if (byContent.size === 0) return;
      await tx
        .insert(eventLedger)
        .values(
          [...byContent.values()].map((row) => ({
            accountId: parsed.data.accountId,
            contentId: row.contentId,
            dedupeKey: retrievalDedupeKey(parsed.data, row.contentId),
            eventType: MCP_RETRIEVAL_EVENT_TYPE,
            metadata: retrievalMetadata(parsed.data),
            requestId: parsed.data.requestId,
            scope: "public" as const,
          })),
        )
        .onConflictDoNothing({ target: eventLedger.dedupeKey });
    });
  } catch (error) {
    console.error("attention_tool_audit_write_failed", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
  }
}
