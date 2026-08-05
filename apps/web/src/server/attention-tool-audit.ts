import "server-only";

import { createHmac } from "node:crypto";

import {
  eventLedger,
  setAccountContext,
  type AttentionDatabase,
} from "@attention/db";
import { z } from "zod";

export const ATTENTION_TOOL_AUDIT_EVENT_TYPE = "agent.tool_call.v1";

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
    contractVersion: opaqueIdentifierSchema,
    credentialId: z.string().uuid(),
    credentialKind: z.enum(["oauth", "pat"]),
    durationMs: z.number().finite().nonnegative().max(86_400_000),
    entrypoint: z.enum(["hosted_agent", "hosted_mcp"]),
    outcome: z.enum(["success", "tool_error", "internal_error", "cancelled"]),
    reportedSkillId: z.literal("attention").nullish(),
    reportedSkillVersion: z.literal("1.0.0").nullish(),
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
    });
  } catch (error) {
    console.error("attention_tool_audit_write_failed", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
  }
}
