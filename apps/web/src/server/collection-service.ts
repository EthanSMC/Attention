import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
} from "node:crypto";

import type { SessionPrincipal } from "@attention/auth";
import {
  buildXiaohongshuAccessUrl,
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
  collectionEvents,
  collections,
  contentAliases,
  contentIdentities,
  contentLinks,
  contents,
  domains,
  eq,
  gt,
  inArray,
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
  type AttentionTransaction,
} from "@attention/db";
import { z } from "zod";

import { collectionPlanCanonical, collectionPlanDigest, loadCollectionEffectPlan, parseCollectionEffectPlan, type CollectionEffectPlan } from "./collection-effect-plan";
export { loadCollectionEffectPlan, parseCollectionEffectPlan } from "./collection-effect-plan";
export type { CollectionEffectPlan } from "./collection-effect-plan";

import { enrichmentResponseFields } from "./content-enrichment-decision";

export { enrichmentResponseFields } from "./content-enrichment-decision";

import {
  decryptCandidateSet,
  encryptCandidateSet,
  type CandidateVaultPayload,
} from "./candidate-vault";
import { FetcherClientError, resolveExternalUrl } from "./fetcher-client";

const parserVersion = "web-v1";
const selectionTtlMilliseconds = 24 * 60 * 60 * 1_000;
const attemptLeaseMilliseconds = 5 * 60 * 1_000;
export type CollectionPrincipal = Pick<
  SessionPrincipal,
  "accountId" | "isFilter" | "isMember"
> & {
  /** Trusted transport policy only; never parsed from collection request data. */
  privateCollectionOnly?: boolean;
  signal?: AbortSignal;
  revalidate?: () => Promise<{ accountId: string; scopes: readonly string[]; isFilter: boolean; isMember: boolean } | null>;
  revalidateInTransaction?: (tx: AttentionTransaction) => Promise<{ accountId: string; scopes: readonly string[]; isFilter: boolean; isMember: boolean } | null>;
};

export async function assertCollectionAuthority(principal: CollectionPrincipal, visibility: "public" | "private"): Promise<void> {
  principal.signal?.throwIfAborted();
  if (principal.revalidate) {
    const current = await principal.revalidate();
    principal.signal?.throwIfAborted();
    if (!current || current.accountId !== principal.accountId || !current.scopes.includes("collection:write") ||
        (visibility === "public" && !current.isFilter)) throw new CollectionServiceError("permission_revoked", 403);
  }
}

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

export interface ResolvedCandidate {
  aliasIdentities: AdapterIdentity[];
  identity: AdapterIdentity;
  outboundUrl: string;
  observedUrl: string;
  selectedUrl: string;
  redirectChain: string[];
  displayHost: string;
  resolutionStatus: "pending" | "resolved";
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

export function selectCandidateOutboundUrl(
  identity: AdapterIdentity,
  observedUrl: string,
): string {
  if (identity.adapter !== "xiaohongshu") return identity.normalizedUrl;
  return buildXiaohongshuAccessUrl(observedUrl) ?? identity.normalizedUrl;
}

function fallbackDirectCandidate(
  url: string,
  match: NonNullable<ReturnType<typeof classifySourceUrl>>,
): ResolvedCandidate | null {
  if (
    match.classification.kind === "download" ||
    match.classification.kind === "marketing"
  ) {
    return null;
  }
  const parsedInput = parseHttpUrl(url);
  if (!parsedInput) return null;
  const identity =
    match.adapter.identity(url) ?? genericWebAdapter.identity(url);
  if (!identity) return null;
  const outboundUrl = selectCandidateOutboundUrl(identity, url);
  const parsedOutbound = parseHttpUrl(outboundUrl);
  if (
    parsedOutbound === null ||
    hasUnsupportedHttpPort(parsedOutbound) ||
    clearlyUnsafeHostname(parsedOutbound.hostname) ||
    dangerousForAdapter(outboundUrl, identity.adapter, "content")
  ) {
    throw new CandidateUnsafeError("unsafe_outbound");
  }
  return {
    aliasIdentities: [],
    displayHost: new URL(url).hostname,
    identity,
    observedUrl: url,
    outboundUrl,
    redirectChain: [],
    resolutionStatus: "pending",
    selectedUrl: url,
  };
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

function hasUnsupportedHttpPort(url: URL): boolean {
  return url.port !== "" && url.port !== "80" && url.port !== "443";
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

/**
 * Validates the final public URL reported by a local Agent without making a
 * server-side network request. The Agent is a fallback reader, not a way to
 * bypass the collection boundary for local targets, credentials or sensitive
 * query material.
 */
export function validateAgentResolvedPublicUrl(rawUrl: string): string | null {
  const parsed = parseHttpUrl(rawUrl);
  if (
    parsed === null ||
    hasUnsupportedHttpPort(parsed) ||
    clearlyUnsafeHostname(parsed.hostname)
  ) {
    return null;
  }
  const match = classifySourceUrl(parsed);
  if (
    match &&
    dangerousForAdapter(parsed.href, match.adapter.id, match.classification.kind)
  ) {
    return null;
  }
  return parsed.href;
}

export async function resolveCandidate(rawUrl: string, options: { signal?: AbortSignal } = {}): Promise<ResolvedCandidate | null> {
  options.signal?.throwIfAborted();
  let currentUrl = rawUrl;
  let match = classifySourceUrl(currentUrl);
  if (!match) return null;

  const parsedCurrent = parseHttpUrl(currentUrl);
  if (
    parsedCurrent === null ||
    hasUnsupportedHttpPort(parsedCurrent) ||
    clearlyUnsafeHostname(parsedCurrent.hostname)
  ) {
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
  const initialMatch = match;
  const initialIdentity =
    match.adapter.identity(rawUrl) ?? genericWebAdapter.identity(rawUrl);
  let redirectChain: string[];
  try {
    const resolved = options.signal
      ? await resolveExternalUrl(currentUrl, initialSource, { signal: options.signal })
      : await resolveExternalUrl(currentUrl, initialSource);
    options.signal?.throwIfAborted();
    currentUrl = resolved.finalUrl;
    redirectChain = resolved.redirectChain;
  } catch (error) {
    options.signal?.throwIfAborted();
    if (error instanceof FetcherClientError) {
      const fallback = fallbackDirectCandidate(currentUrl, match);
      if (fallback) {
        console.warn(JSON.stringify({
          code: error.code,
          event: error.code === "unsafe_address"
            ? "collection.fetcher_safety_fallback"
            : "collection.fetcher_agent_fallback",
          fetcher_request_id: error.requestId,
          source: initialSource,
          url_fingerprint: urlFingerprint(currentUrl),
        }));
        return fallback;
      }
    }
    throw new CandidatePendingError(initialSource);
  }

  match = classifySourceUrl(currentUrl);
  if (!match) return null;
  const parsedResolved = parseHttpUrl(currentUrl);
  if (
    parsedResolved === null ||
    hasUnsupportedHttpPort(parsedResolved) ||
    clearlyUnsafeHostname(parsedResolved.hostname)
  ) {
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
  // A login gate does not invalidate the note. Shortlinks lose their note
  // identity during resolution, but the official login URL retains it in
  // redirectPath. Recover only a validated public Xiaohongshu note URL.
  if (
    initialSource === "xiaohongshu" &&
    parsedResolved.protocol === "https:" &&
    parsedResolved.port === "" &&
    (parsedResolved.hostname === "xiaohongshu.com" ||
      parsedResolved.hostname === "www.xiaohongshu.com") &&
    /^\/login\/?$/u.test(parsedResolved.pathname)
  ) {
    if (initialMatch.classification.kind === "content") {
      const fallback = fallbackDirectCandidate(rawUrl, initialMatch);
      return fallback ? { ...fallback, redirectChain } : null;
    }
    if (initialMatch.classification.kind !== "shortlink") return null;
    const redirectPaths = parsedResolved.searchParams.getAll("redirectPath");
    if (redirectPaths.length === 0) throw new CandidatePendingError(initialSource);
    if (redirectPaths.length !== 1) return null;
    const redirectPath = redirectPaths[0];
    if (!redirectPath) return null;
    const noteUrl = parseHttpUrl(redirectPath.startsWith("/")
      ? `${parsedResolved.origin}${redirectPath}` : redirectPath);
    // Parsing rejects credentials and strips only the scheme's default port.
    if (
      !noteUrl || !["http:", "https:"].includes(noteUrl.protocol) ||
      noteUrl.port !== "" ||
      (noteUrl.hostname !== "xiaohongshu.com" &&
        noteUrl.hostname !== "www.xiaohongshu.com") ||
      !/^\/(?:explore|discovery\/item)\/[A-Za-z0-9_-]{6,128}\/?$/u.test(noteUrl.pathname)
    ) return null;
    const noteMatch = classifySourceUrl(noteUrl);
    if (noteMatch?.adapter.id !== "xiaohongshu" ||
      noteMatch.classification.kind !== "content") return null;
    if (dangerousForAdapter(noteUrl.href, "xiaohongshu", "content")) {
      throw new CandidateUnsafeError("dangerous_query");
    }
    // The official HTTPS login page can embed an HTTP note URL. Treat it
    // only as identity metadata; after validation, construct HTTPS access
    // without requesting the embedded address or relaxing Fetcher policy.
    noteUrl.protocol = "https:";
    const fallback = fallbackDirectCandidate(noteUrl.href, noteMatch);
    if (!fallback) return null;
    return {
      ...fallback,
      aliasIdentities:
        initialIdentity && initialIdentity.dedupeKey !== fallback.identity.dedupeKey
          ? [initialIdentity]
          : [],
      redirectChain,
      selectedUrl: rawUrl,
    };
  }
  // A known shortlink that has not resolved is temporarily unreadable, not
  // an invalid user URL. Do not create content from the shortlink landing page.
  if (initialMatch.classification.kind === "shortlink" &&
    match.classification.kind === "shortlink" && match.adapter.id === initialSource) {
    throw new CandidatePendingError(initialSource);
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
  const outboundUrl = selectCandidateOutboundUrl(identity, currentUrl);
  const parsedOutbound = parseHttpUrl(outboundUrl);
  if (
    parsedOutbound === null ||
    hasUnsupportedHttpPort(parsedOutbound) ||
    clearlyUnsafeHostname(parsedOutbound.hostname) ||
    dangerousForAdapter(outboundUrl, identity.adapter, "content")
  ) {
    throw new CandidateUnsafeError("unsafe_outbound");
  }
  return {
    aliasIdentities:
      initialIdentity && initialIdentity.dedupeKey !== identity.dedupeKey
        ? [initialIdentity]
        : [],
    displayHost: new URL(currentUrl).hostname,
    identity,
    observedUrl: currentUrl,
    outboundUrl,
    redirectChain,
    resolutionStatus: "resolved",
    selectedUrl: rawUrl,
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
  db: AttentionDatabase | AttentionTransaction,
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
    ...enrichmentResponseFields(content, content.outboundUrl),
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
  await assertCollectionAuthority(principal, visibility);
  return db.transaction((tx) => establishCollectionInTransaction(tx, principal, attempt, candidate, visibility, pendingSelection));
}

async function establishCollectionInTransaction(
  tx: AttentionTransaction,
  principal: CollectionPrincipal,
  attempt: InputAttempt,
  candidate: ResolvedCandidate,
  visibility: "public" | "private",
  pendingSelection?: PendingSelectionClaim,
  exactPlan?: CollectionEffectPlan,
): Promise<CollectorResponse> {
  const now = new Date();
  const established = await (async () => {
    await setAccountContext(tx, principal.accountId);
    principal.signal?.throwIfAborted();
    const requirePrivateOnly = () => {
      throw new CollectionServiceError("website_collection_review_required", 409);
    };
    if (principal.privateCollectionOnly && visibility !== "private") requirePrivateOnly();

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
            gt(pendingCandidateSets.expiresAt, sql`clock_timestamp()`),
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
    if (exactPlan && (contentResult.created !== (exactPlan.effects.targetContentId === null) ||
        (exactPlan.effects.targetContentId !== null && contentResult.content.id !== exactPlan.effects.targetContentId))) planChanged();
    if (principal.privateCollectionOnly && !contentResult.created) {
      // Stabilize shared URL/alias state through commit. A provisional upsert
      // loser was removed in this transaction and is not itself a merge effect.
      const [currentContent] = await tx.select().from(contents)
        .where(eq(contents.id, contentResult.content.id)).for("update").limit(1);
      if (!currentContent) throw new Error("collection_content_missing");
      contentResult.content = currentContent;
    }
    const pendingAliasContentIds: string[] = [];
    for (const aliasIdentity of candidate.aliasIdentities) {
      const [existingAliasIdentity] = await tx
        .select({ contentId: contentIdentities.contentId })
        .from(contentIdentities)
        .where(
          and(
            eq(contentIdentities.dedupeKey, aliasIdentity.dedupeKey),
            eq(contentIdentities.active, true),
          ),
        )
        .limit(1);
      if (exactPlan) {
        const expected = exactPlan.snapshot.identities.find((row) => row.dedupeKey === aliasIdentity.dedupeKey && row.active === true);
        if ((existingAliasIdentity?.contentId ?? null) !== (expected?.contentId ?? null)) planChanged();
      }
      if (!existingAliasIdentity) {
        const insertedAliasIdentities = await tx
          .insert(contentIdentities)
          .values({
            adapterVersion: aliasIdentity.adapterVersion,
            contentId: contentResult.content.id,
            dedupeKey: aliasIdentity.dedupeKey,
            identityKind: "normalized",
            normalizedUrl: aliasIdentity.normalizedUrl,
            sourceAdapter: aliasIdentity.adapter,
          })
          .onConflictDoNothing({ target: contentIdentities.dedupeKey }).returning({ id: contentIdentities.id });
        if (exactPlan && insertedAliasIdentities.length !== 1) planChanged();
      } else if (existingAliasIdentity.contentId !== contentResult.content.id) {
        if (principal.privateCollectionOnly) requirePrivateOnly();
        pendingAliasContentIds.push(existingAliasIdentity.contentId);
      }
    }
    if (
      candidate.identity.adapter === "xiaohongshu" &&
      candidate.outboundUrl !== candidate.identity.normalizedUrl
    ) {
      if (principal.privateCollectionOnly && !contentResult.created &&
          contentResult.content.outboundUrl !== candidate.outboundUrl) requirePrivateOnly();
      await tx
        .update(contents)
        .set({ outboundUrl: candidate.outboundUrl, updatedAt: now })
        .where(
          and(
            eq(contents.id, contentResult.content.id),
            eq(contents.source, "xiaohongshu"),
            eq(contents.normalizedUrl, candidate.identity.normalizedUrl),
          ),
        );
    }
    let collectionResult = await upsertCollectionInTransaction(tx, {
      accountId: principal.accountId,
      contentId: contentResult.content.id,
      domainId: domain.id,
      sourceChannel: "web",
      visibility,
    });
    if (exactPlan && (collectionResult.status !== ({ new: "created", reused: "already_collected", restored: "restored" } as const)[exactPlan.effects.targetDisposition] ||
        (exactPlan.effects.targetCollectionId !== null && collectionResult.collection.id !== exactPlan.effects.targetCollectionId))) planChanged();
    if (principal.privateCollectionOnly && collectionResult.collection.visibility !== "private") requirePrivateOnly();
    for (const aliasContentId of pendingAliasContentIds) {
      const aliasCollectionResult = await upsertCollectionInTransaction(tx, {
        accountId: principal.accountId,
        contentId: aliasContentId,
        domainId: domain.id,
        sourceChannel: "web",
        visibility,
      });
      if (exactPlan && aliasCollectionResult.status !== ({ new: "created", reused: "already_collected", restored: "restored" } as const)[exactPlan.effects.aliasCollectionDispositions[aliasContentId]!]) planChanged();
      await tx.execute(sql`
        select public.attention_link_owned_content_alias(
          ${aliasContentId}::uuid,
          ${contentResult.content.id}::uuid,
          'resolved_shortlink_identity'
        )
      `);
    }
    const aliasContents = await tx
      .select({ aliasContentId: contentAliases.aliasContentId })
      .from(contentAliases)
      .where(
        and(
          eq(contentAliases.primaryContentId, contentResult.content.id),
          eq(contentAliases.active, true),
        ),
      );
    const aliasContentIds = aliasContents.map((alias) => alias.aliasContentId);
    if (exactPlan) {
      const expected = [...new Set([...exactPlan.snapshot.aliases.filter((row) => row.active === true && row.primaryContentId === contentResult.content.id).map((row) => String(row.aliasContentId)), ...exactPlan.effects.pendingAliasContentIds])].sort();
      if (collectionPlanCanonical([...aliasContentIds].sort()) !== collectionPlanCanonical(expected)) planChanged();
    }
    const existingAliasCollections = aliasContentIds.length > 0
      ? await tx
          .select()
          .from(collections)
          .where(
            and(
              eq(collections.accountId, principal.accountId),
              inArray(collections.contentId, aliasContentIds),
              eq(collections.collectionStatus, "active"),
            ),
          )
          .for("update")
      : [];
    const mergedAliasCollections = existingAliasCollections.filter(
      (aliasCollection) =>
        aliasCollection.id !== collectionResult.collection.id,
    );
    if (exactPlan) {
      const expectedIds = exactPlan.effects.mergedCollectionIds;
      const existingIds = mergedAliasCollections.filter((row) => exactPlan.snapshot.collections.some((old) => old.id === row.id)).map((row) => row.id).sort();
      if (collectionPlanCanonical(expectedIds) !== collectionPlanCanonical(existingIds)) planChanged();
      for (const row of mergedAliasCollections) {
        const old = exactPlan.snapshot.collections.find((item) => item.id === row.id);
        if (!old && exactPlan.effects.aliasCollectionDispositions[row.contentId] !== "new") planChanged();
        if (old?.collectionStatus === "active" && collectionPlanCanonical(old) !== collectionPlanCanonical(row)) planChanged();
      }
    }
    if (mergedAliasCollections.length > 0) {
      if (principal.privateCollectionOnly) requirePrivateOnly();
      const collectionsToMerge = [
        collectionResult.collection,
        ...mergedAliasCollections,
      ];
      const effectiveVisibility =
        collectionsToMerge.some(
          (collection) => collection.visibility === "public",
        )
          ? "public"
          : "private";
      const publicSince = effectiveVisibility === "public"
        ? collectionsToMerge
            .map((collection) => collection.publicSince)
            .filter((value): value is Date => value !== null)
            .sort((left, right) => left.getTime() - right.getTime())[0] ?? now
        : null;
      const deletedAliasCollections = await tx
        .update(collections)
        .set({ collectionStatus: "deleted", updatedAt: now })
        .where(
          inArray(
            collections.id,
            mergedAliasCollections.map((collection) => collection.id),
          ),
        )
        .returning();
      const earliestCollectedAt = collectionsToMerge
        .map((collection) => collection.collectedAt)
        .sort((left, right) => left.getTime() - right.getTime())[0]!;
      const [mergedCollection] = await tx
        .update(collections)
        .set({
          collectedAt: earliestCollectedAt,
          moderationStatus: collectionsToMerge.some(
            (collection) => collection.moderationStatus === "blocked",
          )
            ? "blocked"
            : "clear",
          publicSince,
          updatedAt: now,
          visibility: effectiveVisibility,
        })
        .where(eq(collections.id, collectionResult.collection.id))
        .returning();
      if (!mergedCollection) throw new Error("collection_alias_merge_failed");
      collectionResult = { ...collectionResult, collection: mergedCollection };
      if (effectiveVisibility === "public") {
        await tx
          .update(contents)
          .set({
            firstPublicAt: sql`coalesce(${contents.firstPublicAt}, ${(publicSince ?? now).toISOString()}::timestamptz)`,
            updatedAt: now,
            visibilityVersion: sql`${contents.visibilityVersion} + 1`,
          })
          .where(eq(contents.id, contentResult.content.id));
      }
      if (deletedAliasCollections.length > 0) {
        const previousById = new Map(
          mergedAliasCollections.map((collection) => [collection.id, collection]),
        );
        await tx.insert(collectionEvents).values(deletedAliasCollections.map(
          (deletedAliasCollection) => {
            const previous = previousById.get(deletedAliasCollection.id)!;
            return {
          accountId: principal.accountId,
          actorAccountId: principal.accountId,
          collectionId: deletedAliasCollection.id,
          contentId: deletedAliasCollection.contentId,
          eventType: "merged_with_existing_content",
          nextState: {
            collectionStatus: "deleted",
            mergedIntoCollectionId: collectionResult.collection.id,
          },
          occurredAt: now,
          previousState: {
                collectionStatus: previous.collectionStatus,
                visibility: previous.visibility,
          },
            };
          },
        ));
      }
    }
    const status =
      mergedAliasCollections.length > 0
        ? "merged_with_existing_content"
        : collectionResult.status === "already_collected"
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
      resolutionStatus: candidate.resolutionStatus,
      resolvedUrl: candidate.observedUrl,
      safeSelectedUrl: candidate.selectedUrl,
      sourceAdapter: candidate.identity.adapter,
    });
    if (
      candidate.resolutionStatus === "pending" &&
      contentResult.content.enrichmentStatus === "pending"
    ) {
      await tx
        .update(contents)
        .set({ enrichmentStatus: "partial", updatedAt: now })
        .where(eq(contents.id, contentResult.content.id));
    }
    const insertedJobs = await tx
      .insert(jobs)
      .values({
        idempotencyKey: `content.metadata.v1:${contentResult.content.id}`,
        payload: { contentId: contentResult.content.id },
        queue: "content-enrichment",
        taskType: "content.metadata.v1",
      })
      .onConflictDoNothing({ target: jobs.idempotencyKey }).returning({ id: jobs.id });
    if (exactPlan && (insertedJobs.length === 1) !== (exactPlan.effects.metadataJob === "schedule")) planChanged();
    if (exactPlan && (collectionResult.collection.visibility !== exactPlan.effects.resultingVisibility || collectionResult.collection.moderationStatus !== exactPlan.effects.resultingModeration || collectionResult.collection.domainId !== exactPlan.effects.resultingDomainId)) planChanged();
    if (exactPlan) {
      const [destination] = await tx.select({ outboundUrl: contents.outboundUrl }).from(contents)
        .where(eq(contents.id, contentResult.content.id)).limit(1);
      if (destination?.outboundUrl !== exactPlan.effects.resultingOutboundUrl) planChanged();
    }
    const [updatedAttempt] = await tx
      .update(inputAttempts)
      .set({
        candidateCount: Math.max(attempt.candidateCount, 1),
        redirectChain: candidate.redirectChain,
        resultCollectionId: collectionResult.collection.id,
        resultContentId: contentResult.content.id,
        safeSelectedUrl: candidate.selectedUrl,
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
    // Never call a root-database revalidation callback while holding this
    // connection. The website supplies a same-transaction fresh authority read.
    if (principal.revalidateInTransaction) {
      await assertCollectionAuthority({ ...principal, revalidate: () => principal.revalidateInTransaction!(tx) }, exactPlan?.effects.resultingVisibility ?? visibility);
    }
    if (pendingSelection) {
      // Expiry is checked against the database wall clock after all effects and
      // same-transaction authorization, not merely the earlier claim timestamp.
      const [unexpired] = await tx.select({ id: pendingCandidateSets.id }).from(pendingCandidateSets).where(and(
        eq(pendingCandidateSets.id, pendingSelection.pendingId),
        eq(pendingCandidateSets.accountId, principal.accountId),
        eq(pendingCandidateSets.tokenHash, pendingSelection.tokenHash),
        gt(pendingCandidateSets.expiresAt, sql`clock_timestamp()`),
      )).limit(1);
      if (!unexpired) throw new CollectionServiceError("selection_expired", 409);
    }
    // Revocation/cancellation rolls back every business write, including
    // provisional identities, events, links and jobs.
    principal.signal?.throwIfAborted();
    return { collectionResult, contentResult, status };
  })();

  return CollectorResponseSchema.parse({
    ...baseResponse(attempt),
    ...enrichmentResponseFields(
      established.contentResult.content,
      candidate.outboundUrl,
    ),
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
  await assertCollectionAuthority(principal, input.visibility);
  const { attempt, fresh } = await beginAttempt(db, principal, input);
  if (!fresh) return replayAttempt(db, principal, attempt);

  const resolved = await resolveCollectionInput(input.raw_input, {
    ...(principal.signal ? { signal: principal.signal } : {}),
    revalidate: () => assertCollectionAuthority(principal, input.visibility),
  });
  if (resolved.status === "resolution_pending") return simpleResponse(db, attempt, {
    status: "resolution_pending", ...(resolved.source ? { source: resolved.source } : {}),
  });
  if (resolved.status !== "resolved") return simpleResponse(db, attempt, {
    status: resolved.status, errorCode: resolved.errorCode ?? "invalid_url",
  });
  const candidates = resolved.candidates;
  await assertCollectionAuthority(principal, input.visibility);
  if (candidates.length > 1) return createAmbiguousResponse(db, attempt, candidates, input.visibility);

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

export interface ResolvedCollectionInput {
  candidates: ResolvedCandidate[];
  status: "resolved" | "invalid" | "unsafe" | "resolution_pending";
  errorCode?: string;
  source?: SourceAdapterId;
}

/** Source/network work only. No attempt, content, collection, link or job writes. */
export async function resolveCollectionInput(raw: string, options: { signal?: AbortSignal; revalidate?: () => Promise<unknown> } = {}): Promise<ResolvedCollectionInput> {
  const rawInput = z.string().trim().min(1).max(MAX_RAW_TEXT_LENGTH).parse(raw);
  const check = async () => { options.signal?.throwIfAborted(); if (options.revalidate) { const result = await options.revalidate(); if (result === null || result === false) throw new CollectionServiceError("permission_revoked", 403); } options.signal?.throwIfAborted(); };
  await check();
  const extracted = extractLinkCandidates(InputEnvelopeSchema.parse({ channel: "web", channel_message_id: "prepared-input", parser_version: parserVersion, payload_type: payloadType(rawInput), raw_payload: rawInput, received_at: new Date().toISOString(), sender_account_id: "00000000-0000-4000-8000-000000000000" }));
  if (!extracted.length) return { status: "invalid", errorCode: "no_content_link", candidates: [] };
  const candidates = new Map<string, ResolvedCandidate>();
  for (const item of extracted) {
    await check();
    try {
      const candidate = await resolveCandidate(item.url, options.signal ? { signal: options.signal } : {});
      await check();
      if (candidate) candidates.set(candidate.identity.dedupeKey, candidate);
    } catch (error) {
      if (error instanceof CandidateUnsafeError) return { status: "unsafe", errorCode: error.message || "unsafe_target", candidates: [] };
      if (error instanceof CandidatePendingError) return { status: "resolution_pending", candidates: [], ...(error.source ? { source: error.source } : {}) };
      throw error;
    }
  }
  return candidates.size ? { status: "resolved", candidates: [...candidates.values()] } : { status: "invalid", errorCode: "non_content_target", candidates: [] };
}

/** This helper is deliberately incapable of establishing a collection. */
export async function prepareSelectionFromResolved(db: AttentionDatabase, principal: CollectionPrincipal, rawInput: CollectRequest, resolved: ResolvedCollectionInput): Promise<CollectorResponse> {
  const input = collectRequestSchema.parse(rawInput);
  if (resolved.status === "resolved" && resolved.candidates.length < 2) throw new CollectionServiceError("selection_requires_multiple_candidates", 422);
  ensurePrincipal(principal, input.visibility);
  await assertCollectionAuthority(principal, input.visibility);
  const { attempt, fresh } = await beginAttempt(db, principal, input);
  if (!fresh) return replayAttempt(db, principal, attempt);
  if (resolved.status === "resolved") {
    return createAmbiguousResponse(db, attempt, resolved.candidates, input.visibility);
  }
  if (resolved.status === "resolution_pending") return simpleResponse(db, attempt, { status: resolved.status, ...(resolved.source ? { source: resolved.source } : {}) });
  return simpleResponse(db, attempt, { status: resolved.status, errorCode: resolved.errorCode ?? "invalid_url" });
}

export interface PendingCandidateBinding {
  attemptId: string;
  pendingId: string;
  tokenHash: string;
  vaultDigest: string;
  visibility: "public" | "private";
  expiresAt: string;
  candidateId?: string | undefined;
}
const pendingCandidateBindingSchema = z.object({ attemptId: z.string().uuid(), pendingId: z.string().uuid(), tokenHash: z.string().regex(/^[a-f0-9]{64}$/), vaultDigest: z.string().regex(/^[a-f0-9]{64}$/), visibility: z.enum(["public", "private"]), expiresAt: z.string().datetime(), candidateId: z.string().uuid().optional() }).strict();
export function parsePendingCandidateBinding(value: unknown): PendingCandidateBinding { return pendingCandidateBindingSchema.parse(value); }
export interface PendingCandidateForReview extends PendingCandidateBinding {
  attempt: InputAttempt;
  candidates: CandidateVaultPayload["candidates"];
  selected?: CandidateVaultPayload["candidates"][number];
  /** Trusted server only. Never put this token in a model or browser response. */
  selectionToken: string;
}

/** Owner-bound, SELECT-only vault bridge; validates both stored hashes and ciphertext digest. */
export async function loadPendingCandidateForReview(db: AttentionDatabase | AttentionTransaction, owner: string, input: { attemptId: string; candidateId?: string; visibility?: "public" | "private" }): Promise<PendingCandidateForReview> {
  const [attempt] = await db.select().from(inputAttempts).where(and(eq(inputAttempts.id, input.attemptId), eq(inputAttempts.accountId, owner))).limit(1);
  const [pending] = await db.select().from(pendingCandidateSets).where(and(eq(pendingCandidateSets.inputAttemptId, input.attemptId), eq(pendingCandidateSets.accountId, owner))).limit(1);
  if (!attempt || !pending || attempt.status !== "ambiguous" || attempt.selectionConsumedAt || pending.consumedAt || pending.expiresAt <= new Date() || !attempt.selectionExpiresAt || attempt.selectionExpiresAt <= new Date()) throw new CollectionServiceError("selection_expired", 409);
  const payload = decryptCandidateSet(pending.encryptedPayload);
  if (tokenHash(payload.selectionToken) !== pending.tokenHash || attempt.selectionTokenHash !== pending.tokenHash || payload.candidates.length !== pending.candidateCount || payload.candidates.length !== attempt.candidateCount) throw new CollectionServiceError("candidate_invalid", 422);
  if (input.visibility && input.visibility !== payload.visibility) throw new CollectionServiceError("selection_visibility_mismatch", 409);
  const selected = input.candidateId ? payload.candidates.find((c) => c.candidateId === input.candidateId) : undefined;
  if (input.candidateId && !selected) throw new CollectionServiceError("candidate_not_found", 404);
  return { attemptId: attempt.id, pendingId: pending.id, tokenHash: pending.tokenHash, vaultDigest: collectionPlanDigest(payload), visibility: payload.visibility, expiresAt: pending.expiresAt.toISOString(), ...(input.candidateId ? { candidateId: input.candidateId } : {}), attempt, candidates: payload.candidates, ...(selected ? { selected } : {}), selectionToken: payload.selectionToken };
}

function planChanged(): never { throw new CollectionServiceError("collection_effect_plan_changed", 409); }

/** Caller owns the transaction. Source resolution must already have finished before entry. */
export async function establishPreparedCollection(tx: AttentionTransaction, principal: CollectionPrincipal, input: { plan: CollectionEffectPlan; attemptInput?: CollectRequest; pending?: PendingCandidateBinding }): Promise<CollectorResponse> {
  if (Boolean(input.pending) === Boolean(input.attemptInput)) throw new CollectionServiceError("prepared_collection_binding_required", 422);
  const plan = parseCollectionEffectPlan(input.plan);
  if (plan.accountId !== principal.accountId) throw new CollectionServiceError("permission_revoked", 403);
  ensurePrincipal(principal, plan.requestedVisibility);
  ensurePrincipal(principal, plan.effects.resultingVisibility);
  principal.signal?.throwIfAborted();
  await setAccountContext(tx, principal.accountId);
  if (principal.revalidate && !principal.revalidateInTransaction) throw new CollectionServiceError("transaction_authority_required", 403);
  if (principal.revalidateInTransaction) await assertCollectionAuthority({ ...principal, revalidate: () => principal.revalidateInTransaction!(tx) }, plan.effects.resultingVisibility);
  // Same ordering as attention_link_owned_content_alias, including absent owner
  // collections. All existing content rows are then locked against state changes.
  const ids = plan.snapshot.contents.map((row) => String(row.id)).sort();
  for (const id of ids) await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${id}, 0))`);
  const identityIds = plan.snapshot.identities.map((row) => String(row.id)).sort();
  if (identityIds.length) await tx.select({ id: contentIdentities.id }).from(contentIdentities).where(inArray(contentIdentities.id, identityIds)).orderBy(contentIdentities.id).for("update");
  if (ids.length) {
    await tx.select({ id: contents.id }).from(contents).where(inArray(contents.id, ids)).orderBy(contents.id).for("update");
    await tx.select({ id: collections.id }).from(collections).where(and(eq(collections.accountId, principal.accountId), inArray(collections.contentId, ids))).orderBy(collections.id).for("update");
  }
  const current = await loadCollectionEffectPlan(tx, principal.accountId, plan.candidate, plan.requestedVisibility);
  if (current.digest !== plan.digest) planChanged();
  let attempt: InputAttempt;
  let pendingSelection: PendingSelectionClaim | undefined;
  if (input.pending) {
    const binding = parsePendingCandidateBinding(input.pending);
    const pending = await loadPendingCandidateForReview(tx, principal.accountId, { attemptId: binding.attemptId, ...(binding.candidateId ? { candidateId: binding.candidateId } : {}), visibility: binding.visibility });
    if (binding.pendingId !== pending.pendingId || binding.tokenHash !== pending.tokenHash || binding.vaultDigest !== pending.vaultDigest || binding.expiresAt !== pending.expiresAt || binding.visibility !== plan.requestedVisibility || !pending.selected || pending.selected.dedupeKey !== plan.candidate.identity.dedupeKey || pending.selected.source !== plan.candidate.identity.adapter || pending.selected.contentType !== plan.candidate.identity.contentType || pending.selected.url !== plan.candidate.selectedUrl) planChanged();
    attempt = pending.attempt;
    pendingSelection = { consumedAt: new Date(), pendingId: pending.pendingId, tokenHash: pending.tokenHash };
  } else {
    if (!input.attemptInput) throw new CollectionServiceError("attempt_input_required", 422);
    const request = collectRequestSchema.parse(input.attemptInput);
    if (request.visibility !== plan.requestedVisibility) planChanged();
    const begun = await beginAttempt(tx, principal, request);
    if (!begun.fresh) throw new CollectionServiceError("attempt_already_used", 409);
    attempt = begun.attempt;
  }
  return establishCollectionInTransaction(tx, { ...principal, privateCollectionOnly: false }, attempt, plan.candidate, plan.requestedVisibility, pendingSelection, plan);
}
