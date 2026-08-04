import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
} from "node:crypto";

import type { SessionPrincipal } from "@attention/auth";
import {
  classifySourceUrl,
  extractLinkCandidates,
  findDangerousUrlParameters,
  genericWebAdapter,
  parseHttpUrl,
  type AdapterClassificationKind,
  type AdapterIdentity,
} from "@attention/collector";
import {
  CollectorResponseSchema,
  ContentTypeSchema,
  InputEnvelopeSchema,
  MAX_RAW_TEXT_LENGTH,
  SourceAdapterIdSchema,
  type CollectorResponse,
  type SourceAdapterId,
} from "@attention/contracts";
import {
  and,
  collections,
  contentLinks,
  contents,
  domains,
  eq,
  gt,
  inputAttempts,
  inputCandidates,
  isNull,
  jobs,
  lte,
  or,
  pendingCandidateSets,
  setAccountContext,
  sql,
  upsertCollectionInTransaction,
  upsertContentByIdentityInTransaction,
  type AttentionDatabase,
} from "@attention/db";
import { z } from "zod";

import {
  decryptCandidateSet,
  encryptCandidateSet,
  type CandidateVaultPayload,
} from "./candidate-vault";
import { FetcherClientError, resolveExternalUrl } from "./fetcher-client";

const parserVersion = "web-v1";
const selectionTtlMilliseconds = 24 * 60 * 60 * 1_000;
const attemptLeaseMilliseconds = 5 * 60 * 1_000;
type CollectionPrincipal = Pick<SessionPrincipal, "accountId" | "isFilter">;

export const collectRequestSchema = z
  .object({
    idempotency_key: z.string().min(8).max(128),
    raw_input: z.string().trim().min(1).max(MAX_RAW_TEXT_LENGTH),
    visibility: z.enum(["public", "private"]),
  })
  .strict();

export const selectCandidateRequestSchema = z
  .object({
    candidate_id: z.string().uuid(),
    selection_token: z.string().min(32).max(512),
    visibility: z.enum(["public", "private"]),
  })
  .strict();

export type CollectRequest = z.infer<typeof collectRequestSchema>;
export type SelectCandidateRequest = z.infer<
  typeof selectCandidateRequestSchema
>;

export class CollectionServiceError extends Error {
  readonly code: string;
  readonly httpStatus: number;

  constructor(code: string, httpStatus: number) {
    super(code);
    this.name = "CollectionServiceError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

interface ResolvedCandidate {
  identity: AdapterIdentity;
  outboundUrl: string;
  observedUrl: string;
  redirectChain: string[];
  displayHost: string;
}

interface PendingSelectionClaim {
  consumedAt: Date;
  pendingId: string;
  tokenHash: string;
}

class CandidateUnsafeError extends Error {}
class CandidatePendingError extends Error {
  readonly source?: SourceAdapterId;

  constructor(source?: SourceAdapterId) {
    super("resolution_pending");
    this.name = "CandidatePendingError";
    if (source !== undefined) this.source = source;
  }
}

function collectionSecret(): string {
  const secret = process.env.ATTENTION_HMAC_SECRET?.trim();
  if (!secret || secret.length < 32) {
    throw new Error("ATTENTION_HMAC_SECRET must contain at least 32 characters");
  }
  return secret;
}

function inputHmac(input: CollectRequest): string {
  return createHmac("sha256", collectionSecret())
    .update("attention:input:v1\0")
    .update(input.visibility)
    .update("\0")
    .update(input.raw_input)
    .digest("hex");
}

function urlFingerprint(url: string): string {
  return createHmac("sha256", collectionSecret())
    .update("attention:url-fingerprint:v1\0")
    .update(url)
    .digest("hex");
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function newSelectionToken(): string {
  return randomBytes(32).toString("base64url");
}

function payloadType(rawInput: string): "text" | "url" {
  const parsed = parseHttpUrl(rawInput);
  return parsed?.href === rawInput ? "url" : "text";
}

function clearlyUnsafeHostname(hostname: string): boolean {
  const value = hostname.toLowerCase().replace(/^\[|\]$/gu, "").replace(/\.+$/u, "");
  if (
    value === "localhost" ||
    value.endsWith(".localhost") ||
    value.endsWith(".local") ||
    value.endsWith(".internal") ||
    value.endsWith(".home.arpa")
  ) {
    return true;
  }

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(value);
  if (ipv4) {
    const octets = ipv4.slice(1).map(Number);
    if (octets.some((octet) => octet > 255)) return true;
    const [a = 0, b = 0, c = 0] = octets;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }

  return (
    value === "::" ||
    value === "::1" ||
    value.startsWith("fc") ||
    value.startsWith("fd") ||
    /^fe[89ab]/u.test(value) ||
    value.startsWith("2001:db8:") ||
    value.startsWith("::ffff:")
  );
}

function dangerousForAdapter(
  url: string,
  adapter: SourceAdapterId,
  classificationKind: AdapterClassificationKind,
): boolean {
  return findDangerousUrlParameters(url).some((finding) => {
    const isPublicXiaohongshuParameter =
      finding.location === "query" &&
      adapter === "xiaohongshu" &&
      classificationKind === "content" &&
      (finding.parameter === "xsec_source" || finding.parameter === "xsec_token");
    return !isPublicXiaohongshuParameter;
  });
}

async function resolveCandidate(rawUrl: string): Promise<ResolvedCandidate | null> {
  let currentUrl = rawUrl;
  let match = classifySourceUrl(currentUrl);
  if (!match) return null;

  if (clearlyUnsafeHostname(new URL(currentUrl).hostname)) {
    throw new CandidateUnsafeError("unsafe_target");
  }
  if (
    dangerousForAdapter(
      currentUrl,
      match.adapter.id,
      match.classification.kind,
    )
  ) {
    throw new CandidateUnsafeError("dangerous_query");
  }
  if (
    match.classification.kind === "download" ||
    match.classification.kind === "marketing"
  ) {
    return null;
  }

  const initialSource = match.adapter.id;
  let redirectChain: string[];
  try {
    const resolved = await resolveExternalUrl(currentUrl, initialSource);
    currentUrl = resolved.finalUrl;
    redirectChain = resolved.redirectChain;
  } catch (error) {
    if (error instanceof FetcherClientError && error.unsafe) {
      throw new CandidateUnsafeError("unsafe_target");
    }
    throw new CandidatePendingError(initialSource);
  }

  match = classifySourceUrl(currentUrl);
  if (!match) return null;
  if (clearlyUnsafeHostname(new URL(currentUrl).hostname)) {
    throw new CandidateUnsafeError("unsafe_target");
  }
  if (
    dangerousForAdapter(
      currentUrl,
      match.adapter.id,
      match.classification.kind,
    )
  ) {
    throw new CandidateUnsafeError("dangerous_query");
  }
  if (
    match.classification.kind === "download" ||
    match.classification.kind === "marketing" ||
    match.classification.kind === "shortlink"
  ) {
    return null;
  }

  const identity =
    match.adapter.identity(currentUrl) ??
    (match.adapter.id === "xiaohongshu"
      ? null
      : genericWebAdapter.identity(currentUrl));
  if (!identity) return null;
  const outboundUrl = identity.normalizedUrl;
  const parsedOutbound = parseHttpUrl(outboundUrl);
  if (
    parsedOutbound === null ||
    clearlyUnsafeHostname(parsedOutbound.hostname) ||
    findDangerousUrlParameters(parsedOutbound).length > 0
  ) {
    throw new CandidateUnsafeError("unsafe_outbound");
  }
  return {
    displayHost: new URL(currentUrl).hostname,
    identity,
    observedUrl: currentUrl,
    outboundUrl,
    redirectChain,
  };
}

type InputAttempt = typeof inputAttempts.$inferSelect;

function attemptWritePredicate(attempt: InputAttempt) {
  return attempt.leaseOwner
    ? and(
        eq(inputAttempts.id, attempt.id),
        eq(inputAttempts.leaseOwner, attempt.leaseOwner),
      )
    : eq(inputAttempts.id, attempt.id);
}

async function beginAttempt(
  db: AttentionDatabase,
  principal: CollectionPrincipal,
  input: CollectRequest,
): Promise<{ attempt: InputAttempt; fresh: boolean }> {
  const now = new Date();
  const leaseOwner = randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + attemptLeaseMilliseconds);
  const hmac = inputHmac(input);
  const [created] = await db
    .insert(inputAttempts)
    .values({
      accountId: principal.accountId,
      candidateCount: 0,
      channel: "web",
      channelMessageId: input.idempotency_key,
      inputHmac: hmac,
      leaseExpiresAt,
      leaseOwner,
      parserVersion,
      payloadType: payloadType(input.raw_input),
      receivedAt: now,
      status: "processing",
      updatedAt: now,
    })
    .onConflictDoNothing({
      target: [
        inputAttempts.channel,
        inputAttempts.accountId,
        inputAttempts.channelMessageId,
      ],
    })
    .returning();
  if (created) return { attempt: created, fresh: true };

  const [existing] = await db
    .select()
    .from(inputAttempts)
    .where(
      and(
        eq(inputAttempts.channel, "web"),
        eq(inputAttempts.accountId, principal.accountId),
        eq(inputAttempts.channelMessageId, input.idempotency_key),
      ),
    )
    .limit(1);
  if (!existing) throw new Error("idempotency_conflict_without_attempt");
  if (existing.inputHmac !== hmac) {
    throw new CollectionServiceError("idempotency_payload_mismatch", 409);
  }

  const [claimed] = await db
    .update(inputAttempts)
    .set({
      errorCode: null,
      leaseExpiresAt,
      leaseOwner,
      status: "processing",
      updatedAt: now,
    })
    .where(
      and(
        eq(inputAttempts.id, existing.id),
        or(
          eq(inputAttempts.status, "resolution_pending"),
          and(
            eq(inputAttempts.status, "processing"),
            or(
              isNull(inputAttempts.leaseExpiresAt),
              lte(inputAttempts.leaseExpiresAt, now),
            ),
          ),
        ),
      ),
    )
    .returning();
  if (claimed) return { attempt: claimed, fresh: true };
  return { attempt: existing, fresh: false };
}

function baseResponse(attempt: InputAttempt) {
  return {
    attempt_id: attempt.id,
    received_at: attempt.receivedAt.toISOString(),
  };
}

async function establishedResponse(
  db: AttentionDatabase,
  principal: CollectionPrincipal,
  attempt: InputAttempt,
): Promise<CollectorResponse> {
  if (!attempt.resultContentId || !attempt.resultCollectionId) {
    throw new Error("terminal_attempt_missing_result");
  }
  const { collection, content } = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.account_id', ${principal.accountId}, true)`,
    );
    const [content] = await tx
      .select()
      .from(contents)
      .where(eq(contents.id, attempt.resultContentId!))
      .limit(1);
    const [collection] = await tx
      .select()
      .from(collections)
      .where(
        and(
          eq(collections.id, attempt.resultCollectionId!),
          eq(collections.accountId, principal.accountId),
        ),
      )
      .limit(1);
    return { collection, content };
  });
  if (!content || !collection) throw new Error("terminal_attempt_result_missing");

  const source = SourceAdapterIdSchema.parse(content.source);
  const contentType = ContentTypeSchema.parse(content.contentType);
  const status = z
    .enum(["accepted", "already_collected", "merged_with_existing_content"])
    .parse(attempt.status);
  return CollectorResponseSchema.parse({
    ...baseResponse(attempt),
    content_id: content.id,
    collection_id: collection.id,
    content_type: contentType,
    current_visibility: collection.visibility,
    ...(content.title ? { display_title: content.title } : {}),
    source,
    status,
  });
}

async function simpleResponse(
  db: AttentionDatabase,
  attempt: InputAttempt,
  input:
    | { status: "invalid" | "unsafe"; errorCode: string }
    | { status: "resolution_pending"; source?: SourceAdapterId },
): Promise<CollectorResponse> {
  const now = new Date();
  const [updated] = await db
    .update(inputAttempts)
    .set({
      errorCode: "errorCode" in input ? input.errorCode : null,
      ...(input.status === "resolution_pending" && input.source
        ? { sourceAdapter: input.source }
        : {}),
      leaseExpiresAt: null,
      leaseOwner: null,
      status: input.status,
      updatedAt: now,
    })
    .where(attemptWritePredicate(attempt))
    .returning();
  if (!updated) throw new Error("attempt_update_failed");

  if (input.status === "invalid" || input.status === "unsafe") {
    return CollectorResponseSchema.parse({
      ...baseResponse(updated),
      error_code: input.errorCode,
      status: input.status,
    });
  }
  return CollectorResponseSchema.parse({
    ...baseResponse(updated),
    ...(input.status === "resolution_pending" && input.source
      ? { source: input.source }
      : {}),
    retry_after_seconds: 300,
    status: "resolution_pending",
  });
}

async function createAmbiguousResponse(
  db: AttentionDatabase,
  attempt: InputAttempt,
  candidates: ResolvedCandidate[],
  visibility: "public" | "private",
): Promise<CollectorResponse> {
  const token = newSelectionToken();
  const expiresAt = new Date(Date.now() + selectionTtlMilliseconds);
  const vaultCandidates: CandidateVaultPayload["candidates"] = candidates.map(
    (candidate) => ({
      candidateId: randomUUID(),
      contentType: candidate.identity.contentType,
      dedupeKey: candidate.identity.dedupeKey,
      displayHost: candidate.displayHost,
      source: candidate.identity.adapter,
      url: candidate.observedUrl,
    }),
  );
  const encryptedPayload = encryptCandidateSet({
    candidates: vaultCandidates,
    selectionToken: token,
    version: 2,
    visibility,
  });
  const hash = tokenHash(token);
  const now = new Date();

  await db.transaction(async (tx) => {
    await tx.insert(inputCandidates).values(
      vaultCandidates.map((candidate, ordinal) => ({
        confidence: 100,
        createdAt: now,
        displayHost: candidate.displayHost,
        id: candidate.candidateId,
        inputAttemptId: attempt.id,
        ordinal,
        sourceAdapter: candidate.source,
        urlFingerprint: urlFingerprint(candidate.url),
      })),
    );
    await tx.insert(pendingCandidateSets).values({
      accountId: attempt.accountId,
      candidateCount: vaultCandidates.length,
      createdAt: now,
      encryptedPayload,
      expiresAt,
      inputAttemptId: attempt.id,
      tokenHash: hash,
    });
    const [updatedAttempt] = await tx
      .update(inputAttempts)
      .set({
        candidateCount: vaultCandidates.length,
        selectionExpiresAt: expiresAt,
        selectionTokenHash: hash,
        leaseExpiresAt: null,
        leaseOwner: null,
        status: "ambiguous",
        updatedAt: now,
      })
      .where(attemptWritePredicate(attempt))
      .returning({ id: inputAttempts.id });
    if (!updatedAttempt) {
      throw new CollectionServiceError("attempt_lease_lost", 409);
    }
  });

  return CollectorResponseSchema.parse({
    ...baseResponse(attempt),
    candidates: vaultCandidates.map((candidate) => ({
      candidate_id: candidate.candidateId,
      content_type: candidate.contentType,
      display_host: candidate.displayHost,
      source: candidate.source,
    })),
    selection_expires_at: expiresAt.toISOString(),
    selection_token: token,
    status: "ambiguous",
  });
}

async function replayAmbiguousResponse(
  db: AttentionDatabase,
  attempt: InputAttempt,
): Promise<CollectorResponse> {
  const [pending] = await db
    .select()
    .from(pendingCandidateSets)
    .where(
      and(
        eq(pendingCandidateSets.inputAttemptId, attempt.id),
        eq(pendingCandidateSets.accountId, attempt.accountId),
      ),
    )
    .limit(1);
  if (!pending || pending.consumedAt) {
    throw new CollectionServiceError("selection_expired", 409);
  }

  const now = new Date();
  if (pending.expiresAt <= now) {
    await db
      .update(pendingCandidateSets)
      .set({ encryptedPayload: "" })
      .where(
        and(
          eq(pendingCandidateSets.id, pending.id),
          isNull(pendingCandidateSets.consumedAt),
        ),
      );
    throw new CollectionServiceError("selection_expired", 409);
  }

  const payload = decryptCandidateSet(pending.encryptedPayload);
  if (tokenHash(payload.selectionToken) !== pending.tokenHash) {
    throw new CollectionServiceError("selection_expired", 409);
  }

  return CollectorResponseSchema.parse({
    ...baseResponse(attempt),
    candidates: payload.candidates.map((candidate) => ({
      candidate_id: candidate.candidateId,
      content_type: candidate.contentType,
      display_host: candidate.displayHost,
      source: candidate.source,
    })),
    selection_expires_at: pending.expiresAt.toISOString(),
    selection_token: payload.selectionToken,
    status: "ambiguous",
  });
}

async function replayAttempt(
  db: AttentionDatabase,
  principal: CollectionPrincipal,
  attempt: InputAttempt,
): Promise<CollectorResponse> {
  if (
    attempt.status === "accepted" ||
    attempt.status === "already_collected" ||
    attempt.status === "merged_with_existing_content"
  ) {
    return establishedResponse(db, principal, attempt);
  }
  if (attempt.status === "ambiguous") {
    return replayAmbiguousResponse(db, attempt);
  }
  if (attempt.status === "invalid" || attempt.status === "unsafe") {
    return CollectorResponseSchema.parse({
      ...baseResponse(attempt),
      error_code: attempt.errorCode ?? "invalid_url",
      status: attempt.status,
    });
  }
  return CollectorResponseSchema.parse({
    ...baseResponse(attempt),
    ...(attempt.sourceAdapter
      ? { source: SourceAdapterIdSchema.parse(attempt.sourceAdapter) }
      : {}),
    retry_after_seconds: 15,
    status: "resolution_pending",
  });
}

async function establishCollection(
  db: AttentionDatabase,
  principal: CollectionPrincipal,
  attempt: InputAttempt,
  candidate: ResolvedCandidate,
  visibility: "public" | "private",
  pendingSelection?: PendingSelectionClaim,
): Promise<CollectorResponse> {
  const now = new Date();
  const established = await db.transaction(async (tx) => {
    await setAccountContext(tx, principal.accountId);

    if (pendingSelection) {
      const [claimedCandidateSet] = await tx
        .update(pendingCandidateSets)
        .set({
          consumedAt: pendingSelection.consumedAt,
          encryptedPayload: "",
        })
        .where(
          and(
            eq(pendingCandidateSets.id, pendingSelection.pendingId),
            eq(pendingCandidateSets.accountId, principal.accountId),
            eq(pendingCandidateSets.tokenHash, pendingSelection.tokenHash),
            gt(pendingCandidateSets.expiresAt, pendingSelection.consumedAt),
            isNull(pendingCandidateSets.consumedAt),
          ),
        )
        .returning({ id: pendingCandidateSets.id });
      if (!claimedCandidateSet) {
        throw new CollectionServiceError("selection_expired", 409);
      }
      await tx
        .update(inputAttempts)
        .set({ selectionConsumedAt: pendingSelection.consumedAt })
        .where(
          and(
            eq(inputAttempts.id, attempt.id),
            eq(inputAttempts.accountId, principal.accountId),
          ),
        );
    }

    const [domain] = await tx
      .select({ id: domains.id })
      .from(domains)
      .where(and(eq(domains.slug, "ai"), eq(domains.active, true)))
      .limit(1);
    if (!domain) throw new Error("ai_domain_not_configured");

    const contentResult = await upsertContentByIdentityInTransaction(tx, {
      adapterVersion: candidate.identity.adapterVersion,
      canonicalUrl: candidate.identity.normalizedUrl,
      contentType: candidate.identity.contentType,
      dedupeKey: candidate.identity.dedupeKey,
      identityKind: "normalized",
      normalizedUrl: candidate.identity.normalizedUrl,
      outboundUrl: candidate.outboundUrl,
      source: candidate.identity.adapter,
      sourceAdapter: candidate.identity.adapter,
    });
    const collectionResult = await upsertCollectionInTransaction(tx, {
      accountId: principal.accountId,
      contentId: contentResult.content.id,
      domainId: domain.id,
      sourceChannel: "web",
      visibility,
    });
    const status =
      collectionResult.status === "already_collected"
        ? "already_collected"
        : contentResult.created
          ? "accepted"
          : "merged_with_existing_content";

    await tx.insert(contentLinks).values({
      adapterVersion: candidate.identity.adapterVersion,
      contentId: contentResult.content.id,
      inputAttemptId: attempt.id,
      normalizedUrl: candidate.identity.normalizedUrl,
      observedAt: now,
      redirectChain: candidate.redirectChain,
      resolvedUrl: candidate.observedUrl,
      safeSelectedUrl: candidate.observedUrl,
      sourceAdapter: candidate.identity.adapter,
    });
    await tx
      .insert(jobs)
      .values({
        idempotencyKey: `content.metadata.v1:${contentResult.content.id}`,
        payload: { contentId: contentResult.content.id },
        queue: "content-enrichment",
        taskType: "content.metadata.v1",
      })
      .onConflictDoNothing({ target: jobs.idempotencyKey });
    const [updatedAttempt] = await tx
      .update(inputAttempts)
      .set({
        candidateCount: Math.max(attempt.candidateCount, 1),
        redirectChain: candidate.redirectChain,
        resultCollectionId: collectionResult.collection.id,
        resultContentId: contentResult.content.id,
        safeSelectedUrl: candidate.observedUrl,
        sourceAdapter: candidate.identity.adapter,
        leaseExpiresAt: null,
        leaseOwner: null,
        status,
        updatedAt: now,
      })
      .where(attemptWritePredicate(attempt))
      .returning({ id: inputAttempts.id });
    if (!updatedAttempt) {
      throw new CollectionServiceError("attempt_lease_lost", 409);
    }
    return { collectionResult, contentResult, status };
  });

  return CollectorResponseSchema.parse({
    ...baseResponse(attempt),
    collection_id: established.collectionResult.collection.id,
    content_id: established.contentResult.content.id,
    content_type: candidate.identity.contentType,
    current_visibility: established.collectionResult.collection.visibility,
    ...(established.contentResult.content.title
      ? { display_title: established.contentResult.content.title }
      : {}),
    source: candidate.identity.adapter,
    status: established.status,
  });
}

function ensurePrincipal(
  principal: CollectionPrincipal,
  visibility: "public" | "private",
): void {
  if (visibility === "public" && !principal.isFilter) {
    throw new CollectionServiceError("filter_required", 403);
  }
}

export async function collectFromWeb(
  db: AttentionDatabase,
  principal: CollectionPrincipal,
  rawInput: unknown,
): Promise<CollectorResponse> {
  const input = collectRequestSchema.parse(rawInput);
  ensurePrincipal(principal, input.visibility);
  const { attempt, fresh } = await beginAttempt(db, principal, input);
  if (!fresh) return replayAttempt(db, principal, attempt);

  const envelope = InputEnvelopeSchema.parse({
    channel: "web",
    channel_message_id: input.idempotency_key,
    parser_version: parserVersion,
    payload_type: payloadType(input.raw_input),
    raw_payload: input.raw_input,
    received_at: attempt.receivedAt.toISOString(),
    sender_account_id: principal.accountId,
  });
  const extracted = extractLinkCandidates(envelope);
  if (extracted.length === 0) {
    return simpleResponse(db, attempt, {
      errorCode: "no_content_link",
      status: "invalid",
    });
  }

  const resolved = new Map<string, ResolvedCandidate>();
  for (const candidate of extracted) {
    try {
      const result = await resolveCandidate(candidate.url);
      if (result) resolved.set(result.identity.dedupeKey, result);
    } catch (error) {
      if (error instanceof CandidateUnsafeError) {
        return simpleResponse(db, attempt, {
          errorCode: error.message || "unsafe_target",
          status: "unsafe",
        });
      }
      if (error instanceof CandidatePendingError) {
        return simpleResponse(db, attempt, {
          ...(error.source ? { source: error.source } : {}),
          status: "resolution_pending",
        });
      }
      throw error;
    }
  }

  const candidates = [...resolved.values()];
  if (candidates.length === 0) {
    return simpleResponse(db, attempt, {
      errorCode: "non_content_target",
      status: "invalid",
    });
  }
  if (candidates.length > 1) {
    return createAmbiguousResponse(db, attempt, candidates, input.visibility);
  }

  return establishCollection(db, principal, attempt, candidates[0]!, input.visibility);
}

export async function selectCandidateFromWeb(
  db: AttentionDatabase,
  principal: CollectionPrincipal,
  rawInput: unknown,
): Promise<CollectorResponse> {
  const input = selectCandidateRequestSchema.parse(rawInput);
  ensurePrincipal(principal, input.visibility);
  const hash = tokenHash(input.selection_token);
  const [pending] = await db
    .select()
    .from(pendingCandidateSets)
    .where(
      and(
        eq(pendingCandidateSets.accountId, principal.accountId),
        eq(pendingCandidateSets.tokenHash, hash),
      ),
    )
    .limit(1);
  if (!pending || pending.consumedAt) {
    throw new CollectionServiceError("selection_expired", 409);
  }

  const selectionNow = new Date();
  if (pending.expiresAt <= selectionNow) {
    await db
      .update(pendingCandidateSets)
      .set({ encryptedPayload: "" })
      .where(
        and(
          eq(pendingCandidateSets.id, pending.id),
          isNull(pendingCandidateSets.consumedAt),
        ),
      );
    throw new CollectionServiceError("selection_expired", 409);
  }

  const payload = decryptCandidateSet(pending.encryptedPayload);
  if (payload.visibility !== input.visibility) {
    throw new CollectionServiceError("selection_visibility_mismatch", 409);
  }
  const selected = payload.candidates.find(
    (candidate) => candidate.candidateId === input.candidate_id,
  );
  if (!selected) {
    throw new CollectionServiceError("candidate_not_found", 404);
  }
  let resolvedSelected: ResolvedCandidate | null;
  try {
    resolvedSelected = await resolveCandidate(selected.url);
  } catch (error) {
    if (error instanceof CandidateUnsafeError) {
      throw new CollectionServiceError("unsafe_target", 422);
    }
    if (error instanceof CandidatePendingError) {
      throw new CollectionServiceError("resolution_pending", 409);
    }
    throw error;
  }
  if (
    !resolvedSelected ||
    resolvedSelected.identity.dedupeKey !== selected.dedupeKey ||
    resolvedSelected.identity.adapter !== selected.source ||
    resolvedSelected.identity.contentType !== selected.contentType
  ) {
    throw new CollectionServiceError("candidate_invalid", 422);
  }
  const [attempt] = await db
    .select()
    .from(inputAttempts)
    .where(eq(inputAttempts.id, pending.inputAttemptId))
    .limit(1);
  if (!attempt || attempt.accountId !== principal.accountId) {
    throw new CollectionServiceError("candidate_not_found", 404);
  }

  return establishCollection(
    db,
    principal,
    attempt,
    resolvedSelected,
    payload.visibility,
    {
      consumedAt: new Date(),
      pendingId: pending.id,
      tokenHash: hash,
    },
  );
}
