import "server-only";

import { createHash } from "node:crypto";
import { z } from "zod";
import { ExtractionMethodSchema } from "@attention/content-reader-contracts";
import { collectionSourceRequestSchema, readCollectionSource, type CollectionSourceReadyEvidence } from "./collection-source-reader";
import { enrichmentHash } from "./content-enrichment-plan";
import { validateAgentResolvedPublicUrl } from "./collection-service";
import type { AttentionToolContext } from "./attention-tool-registry";

export const WEBSITE_ENRICHMENT_EVIDENCE_TTL_MS = 120_000;
export const websiteEnrichmentRunIdentitySchema = z.object({ accountId: z.uuid(), authSessionId: z.uuid(), sessionId: z.uuid(),
  originRunId: z.uuid(), originRevision: z.number().int().nonnegative().max(2_147_483_645) }).strict();
export type WebsiteEnrichmentRunIdentity = z.infer<typeof websiteEnrichmentRunIdentitySchema>;
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const websiteSourceAttestationSchema = websiteEnrichmentRunIdentitySchema.extend({ version: z.literal(1),
  readerPolicyVersion: z.literal("owned-article-v1"), collectionId: z.uuid(), contentId: z.uuid(),
  operation: hash, sourceFingerprint: hash, sourceUrl: z.string().min(1).max(4096), finalPublicUrl: z.string().min(1).max(4096),
  extractionMethod: ExtractionMethodSchema.exclude(["metadata", "none"]), truncated: z.boolean(),
  readAt: z.iso.datetime({offset: true}), observedAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
  textDigest: hash, requestRef: z.string().min(1).max(128), attemptRef: z.string().min(1).max(128),
}).strict();
export type WebsiteSourceAttestation = z.infer<typeof websiteSourceAttestationSchema>;
export class WebsiteSourceEvidenceError extends Error {
  constructor(readonly code: "source_evidence_required" | "source_evidence_invalid" | "source_evidence_expired" | "source_evidence_changed") {
    super(code); this.name = "WebsiteSourceEvidenceError";
  }
}
export function websiteSourceAttemptRef(identity: WebsiteEnrichmentRunIdentity, collectionId: string): string {
  return `we:${enrichmentHash("read-attempt", { identity: websiteEnrichmentRunIdentitySchema.parse(identity), collectionId: z.uuid().parse(collectionId) })}`;
}
export function parseWebsiteSourceAttestation(value: unknown): WebsiteSourceAttestation {
  try {
    const parsed = websiteSourceAttestationSchema.parse(value);
    const observed = Date.parse(parsed.observedAt), read = Date.parse(parsed.readAt), expires = Date.parse(parsed.expiresAt);
    if (Buffer.byteLength(JSON.stringify(parsed)) > 12288 || read > observed + 5000 || observed - read >= WEBSITE_ENRICHMENT_EVIDENCE_TTL_MS ||
        expires <= observed || expires > Math.min(read, observed) + WEBSITE_ENRICHMENT_EVIDENCE_TTL_MS ||
        validateAgentResolvedPublicUrl(parsed.finalPublicUrl) !== parsed.finalPublicUrl ||
        validateAgentResolvedPublicUrl(parsed.sourceUrl) !== parsed.sourceUrl ||
        parsed.attemptRef !== websiteSourceAttemptRef(runIdentity(parsed), parsed.collectionId) ||
        parsed.requestRef !== `website-evidence:${parsed.originRunId}` ||
        parsed.sourceFingerprint !== createHash("sha256").update(parsed.sourceUrl).digest("hex")) throw new Error("invalid");
    return parsed;
  } catch { throw new WebsiteSourceEvidenceError("source_evidence_invalid"); }
}
export function runIdentity(value: WebsiteSourceAttestation): WebsiteEnrichmentRunIdentity {
  const { accountId, authSessionId, sessionId, originRunId, originRevision } = value;
  return { accountId, authSessionId, sessionId, originRunId, originRevision };
}
export function assertWebsiteSourceAttestation(raw: WebsiteSourceAttestation, identity: WebsiteEnrichmentRunIdentity, now = new Date()): WebsiteSourceAttestation {
  const evidence = parseWebsiteSourceAttestation(raw);
  if (enrichmentHash("identity", runIdentity(evidence)) !== enrichmentHash("identity", websiteEnrichmentRunIdentitySchema.parse(identity)))
    throw new WebsiteSourceEvidenceError("source_evidence_changed");
  if (Date.parse(evidence.expiresAt) <= now.getTime() || Date.parse(evidence.observedAt) > now.getTime() + 5000)
    throw new WebsiteSourceEvidenceError("source_evidence_expired");
  return evidence;
}
export interface WebsiteSourceEvidenceRun {
  identity: WebsiteEnrichmentRunIdentity;
  readCollectionSource: typeof readCollectionSource;
  evidenceFor(contentId: string): WebsiteSourceAttestation;
}
/** Server-created run-local store. Its observer sees real Core reader output only after final ownership/auth checks. */
export function createWebsiteSourceEvidenceRun(rawIdentity: WebsiteEnrichmentRunIdentity, now: () => Date = () => new Date()): WebsiteSourceEvidenceRun {
  const identity = websiteEnrichmentRunIdentitySchema.parse(rawIdentity), evidence = new Map<string, WebsiteSourceAttestation>();
  const unavailable = new Map<string, WebsiteSourceEvidenceError>();
  function observe(value: CollectionSourceReadyEvidence) {
    const observedAt = now(), readAt = Date.parse(value.result.read_at);
    // A readable article can be too old for a mutation review. Do not falsely
    // turn that into a source/auth failure or preserve an older attestation.
    if (observedAt.getTime() - readAt >= WEBSITE_ENRICHMENT_EVIDENCE_TTL_MS) {
      evidence.delete(value.contentId); unavailable.set(value.contentId, new WebsiteSourceEvidenceError("source_evidence_expired")); return;
    }
    try {
      const record = parseWebsiteSourceAttestation({ ...identity, version: 1, readerPolicyVersion: "owned-article-v1",
        collectionId: value.collectionId, contentId: value.contentId, operation: value.operation,
        sourceFingerprint: value.sourceFingerprint, sourceUrl: value.sourceUrl, finalPublicUrl: value.result.final_public_url,
        extractionMethod: value.result.extraction_method, truncated: value.result.truncated, readAt: value.result.read_at,
        observedAt: observedAt.toISOString(), expiresAt: new Date(Math.min(readAt, observedAt.getTime()) + WEBSITE_ENRICHMENT_EVIDENCE_TTL_MS).toISOString(),
        textDigest: createHash("sha256").update(value.result.temporary_text, "utf8").digest("hex"),
        requestRef: value.result.request_ref, attemptRef: value.result.attempt_ref,
      });
      evidence.set(record.contentId, record); unavailable.delete(record.contentId);
    } catch {
      evidence.delete(value.contentId); unavailable.set(value.contentId, new WebsiteSourceEvidenceError("source_evidence_invalid"));
    }
  }
  return { identity: structuredClone(identity),
    async readCollectionSource(context, rawInput, dependencies) {
      const caller = (context as Partial<Pick<AttentionToolContext, "caller">>).caller;
      if (context.accountId !== identity.accountId || caller?.credentialId !== identity.authSessionId ||
          caller.credentialKind !== "session" || caller.entrypoint !== "hosted_agent")
        throw new WebsiteSourceEvidenceError("source_evidence_changed");
      const input = collectionSourceRequestSchema.parse(rawInput);
      const attemptRef = websiteSourceAttemptRef(identity, input.collection_id);
      // Cache keys include this server-owned run reference; model references cannot relabel old evidence.
      const result = await readCollectionSource({ ...context, runId: `website-evidence:${identity.originRunId}`,
        observeReadyEvidence: observe }, { collection_id: input.collection_id, attempt_ref: attemptRef }, dependencies);
      return result;
    },
    evidenceFor(contentId) {
      const failure = unavailable.get(contentId); if (failure) throw failure;
      const record = evidence.get(contentId);
      if (!record) throw new WebsiteSourceEvidenceError("source_evidence_required");
      return structuredClone(assertWebsiteSourceAttestation(record, identity, now()));
    },
  };
}
