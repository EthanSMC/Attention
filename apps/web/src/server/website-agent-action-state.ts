import "server-only";

import { randomUUID } from "node:crypto";
import { z } from "zod";

import { parseWebsiteAgentActionProposal, type WebsiteAgentActionProposal } from "./website-agent-action-policy";

export const WEBSITE_AGENT_ACTION_TTL_MS = 5 * 60_000;
export const WEBSITE_AGENT_ACTION_LEASE_MS = 60_000;
export const WEBSITE_AGENT_MAX_ACTIONS = 8;
export const WEBSITE_AGENT_MAX_NEW_ACTIONS = 4;
const MAX_ACTION_BYTES = 48_000;
const proposalKeys = ["version", "toolName", "contractVersion", "arguments", "argumentsHash", "targetFingerprint", "requiredScopes", "review", "prepared"] as const;
const metadataSchema = z.object({
  id: z.string().uuid(), authSessionId: z.string().uuid(), originRunId: z.string().uuid(),
  originRevision: z.number().int().min(0).max(2_147_483_645),
  createdAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
  status: z.enum(["pending", "executing", "completed", "failed", "unknown", "cancelled", "expired"]),
  claimId: z.string().uuid().nullable(), deadline: z.iso.datetime().nullable(),
  receipt: z.object({ ok: z.boolean(), code: z.string().min(1).max(96), message: z.string().max(1_000) }).strict().nullable(),
}).strict();
type Metadata = z.infer<typeof metadataSchema>;
export type StoredWebsiteAgentAction = WebsiteAgentActionProposal & Metadata;
export function storedWebsiteAgentActionProposal(action: StoredWebsiteAgentAction): WebsiteAgentActionProposal {
  return parseWebsiteAgentActionProposal(Object.fromEntries(proposalKeys.map(key => [key, action[key]])));
}
export interface WebsiteAgentActionView {
  id: string;
  toolName: WebsiteAgentActionProposal["toolName"];
  argumentsHash: string;
  expiresAt: string;
  status: Metadata["status"];
  review: WebsiteAgentActionProposal["review"];
  receipt: Metadata["receipt"];
  candidates?: Array<{ candidateId: string; url: string; displayHost: string; source: string; contentType: string }>;
}

function fail(): never { throw new Error("invalid_website_agent_action_state"); }
export function parseStoredWebsiteAgentAction(value: unknown): StoredWebsiteAgentAction {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const record = value as Record<string, unknown>;
  const proposal = parseWebsiteAgentActionProposal(Object.fromEntries(proposalKeys.map(key => [key, record[key]])));
  const metadata = metadataSchema.parse(Object.fromEntries(Object.entries(record).filter(([key]) => !proposalKeys.includes(key as typeof proposalKeys[number]))));
  const created = Date.parse(metadata.createdAt), expires = Date.parse(metadata.expiresAt);
  if (expires <= created || expires - created > WEBSITE_AGENT_ACTION_TTL_MS ||
      (metadata.status === "executing") !== Boolean(metadata.claimId && metadata.deadline) ||
      (metadata.status !== "executing" && (metadata.claimId !== null || metadata.deadline !== null)) ||
      (metadata.deadline && (Date.parse(metadata.deadline) > expires || Date.parse(metadata.deadline) <= created)) ||
      ((metadata.status === "completed" || metadata.status === "failed" || metadata.status === "unknown") && !metadata.receipt) ||
      ((metadata.status === "pending" || metadata.status === "executing") && metadata.receipt !== null)) return fail();
  if (proposal.prepared?.kind === "enrichment") {
    const evidence = proposal.prepared.evidence;
    if (metadata.authSessionId !== evidence.authSessionId || metadata.originRunId !== evidence.originRunId ||
        metadata.originRevision !== evidence.originRevision || expires > Date.parse(proposal.prepared.expiresAt)) return fail();
  }
  const parsed = { ...proposal, ...metadata };
  if (Buffer.byteLength(JSON.stringify(parsed)) > MAX_ACTION_BYTES) return fail();
  return structuredClone(parsed);
}
export function parseStoredWebsiteAgentActions(value: unknown): StoredWebsiteAgentAction[] {
  if (!Array.isArray(value) || value.length > WEBSITE_AGENT_MAX_ACTIONS || Buffer.byteLength(JSON.stringify(value)) > MAX_ACTION_BYTES) return fail();
  const actions = value.map(parseStoredWebsiteAgentAction);
  if (new Set(actions.map(action => action.id)).size !== actions.length || actions.filter(action => action.status === "executing").length > 1) return fail();
  return actions;
}
export function pendingWebsiteAgentAction(input: {
  proposal: WebsiteAgentActionProposal; authSessionId: string; originRunId: string; originRevision: number; now?: Date;
}): StoredWebsiteAgentAction {
  const now = input.now ?? new Date();
  const prepared = input.proposal.prepared;
  const vaultExpiry = prepared?.kind === "candidate_options" || prepared?.kind === "enrichment" ? Date.parse(prepared.expiresAt)
    : prepared?.kind === "collection" && prepared.pending ? Date.parse(prepared.pending.expiresAt) : Infinity;
  return parseStoredWebsiteAgentAction({ ...input.proposal, id: randomUUID(), authSessionId: input.authSessionId,
    originRunId: input.originRunId, originRevision: input.originRevision, createdAt: now.toISOString(),
    expiresAt: new Date(Math.min(now.getTime() + WEBSITE_AGENT_ACTION_TTL_MS, vaultExpiry)).toISOString(),
    status: "pending", claimId: null, deadline: null, receipt: null });
}
export function websiteAgentActionViews(actions: StoredWebsiteAgentAction[], now: Date): WebsiteAgentActionView[] {
  return actions.map(action => ({ id: action.id, toolName: action.toolName, argumentsHash: action.argumentsHash,
    expiresAt: action.expiresAt, status: action.status === "pending" && Date.parse(action.expiresAt) <= now.getTime() ? "expired" : action.status,
    review: structuredClone(action.review), receipt: structuredClone(action.receipt),
    ...(action.prepared?.kind === "candidate_options" ? { candidates: structuredClone(action.prepared.options) } : {}) }));
}
export function settleWebsiteAgentActions(actions: StoredWebsiteAgentAction[], now: Date, close = false): StoredWebsiteAgentAction[] {
  return actions.map(action => {
    if (action.status === "pending" && (close || Date.parse(action.expiresAt) <= now.getTime())) {
      return { ...action, status: close ? "cancelled" : "expired", claimId: null, deadline: null };
    }
    if (action.status === "executing" && (close || Date.parse(action.deadline!) <= now.getTime())) {
      return { ...action, status: "unknown", claimId: null, deadline: null,
        receipt: { ok: false, code: "outcome_unknown", message: "Execution was interrupted. Do not retry automatically; check the current Attention state." } };
    }
    return action;
  });
}
export function cancelPendingWebsiteAgentActions(actions: StoredWebsiteAgentAction[]): StoredWebsiteAgentAction[] {
  return actions.map(action => action.status === "pending" ? { ...action, status: "cancelled" } : action);
}
export function appendWebsiteAgentActions(prior: StoredWebsiteAgentAction[], proposed: StoredWebsiteAgentAction[]): StoredWebsiteAgentAction[] {
  if (proposed.length > WEBSITE_AGENT_MAX_NEW_ACTIONS || proposed.some(action => action.status !== "pending")) return fail();
  const result = [...prior, ...proposed];
  // Old terminal cards can be retired. A missing action ID is never executable.
  while (result.length > WEBSITE_AGENT_MAX_ACTIONS || Buffer.byteLength(JSON.stringify(result)) > MAX_ACTION_BYTES) {
    const index = result.findIndex(action => ["completed", "failed", "cancelled", "expired"].includes(action.status));
    if (index < 0) return fail();
    result.splice(index, 1);
  }
  return parseStoredWebsiteAgentActions(result);
}
