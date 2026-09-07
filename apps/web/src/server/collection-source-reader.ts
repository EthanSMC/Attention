import "server-only";
import {createHash} from "node:crypto";
import {setTimeout as delay} from "node:timers/promises";
import {z} from "zod";
import {OwnedReadResultSchema, ReadResultSchema, SafeReferenceSchema, SourceKindSchema, readFailurePolicy,
  type ReadFailureCode, type ReadRequest, type ReadResult, type OwnedReadResult} from "@attention/content-reader-contracts";
import type {AttentionDatabase} from "@attention/db";
import {getCollectionStatus, CollectionStatusServiceError, type CollectionStatusResult} from "./collection-status-service";
import {createSourceReadCoordinator, SourceReadMemory, type SourceReadCoordinator, type SourceReadScope} from "./source-read-coordinator";
import {readExternalSource, FetcherClientError} from "./fetcher-client";

export const collectionSourceRequestSchema = z.object({collection_id: z.string().uuid(), attempt_ref: SafeReferenceSchema,
  client_context: z.object({skill_id: z.literal("attention").optional(), skill_version: z.string().regex(/^1\.[0-9]\.0$/u).optional(),
    workflow_run_id: SafeReferenceSchema.optional()}).strict().optional(),
}).strict();
export interface SourceReadPrincipal {accountId: string; scopes: readonly string[]; isMember: boolean; isFilter: boolean}
export interface SourceReadContext {
  accountId: string; runId: string; signal: AbortSignal; getDatabase(): AttentionDatabase;
  revalidate?: () => Promise<SourceReadPrincipal | null>;
}
export class CollectionSourceReadError extends Error {
  constructor(readonly code: "invalid_request" | "permission_revoked" | "collection_not_found", readonly httpStatus: number) {
    super(code); this.name = "CollectionSourceReadError";
  }
}
export interface SourceReadDependencies {
  read(request: ReadRequest, options: {signal: AbortSignal; admissionReference: string}): Promise<ReadResult>;
  coordinator: SourceReadCoordinator;
  memory: SourceReadMemory;
}
const memory = new SourceReadMemory();
const fingerprint = (value: string) => createHash("sha256").update(value).digest("hex");

/** Includes the exact current source and both Core revisions; caller fields grant no authority. */
export function sourceReadIdentity(status: CollectionStatusResult) {
  const collection = status.collection, content = status.content;
  if (!collection || !content || collection.collection_status !== "active" || collection.moderation_status !== "clear") return null;
  if (content.enrichment_action !== "generate_summary" || !content.public_read_url) return null;
  const url = new URL(content.public_read_url).toString();
  const sourceKind = SourceKindSchema.safeParse(content.source);
  return {url, sourceKind: sourceKind.success ? sourceKind.data : "generic_web" as const,
    sourceFingerprint: fingerprint(url), operation: fingerprint(JSON.stringify([
      collection.collection_id, collection.updated_at, content.content_id, content.updated_at, content.source, url,
    ]))};
}
function failed(request: Pick<ReadRequest, "request_ref" | "attempt_ref">, code: ReadFailureCode,
  attempts: ReadResult["attempts"] = [], retryAfterMs: number | null = null): ReadResult {
  const policy = readFailurePolicy(code);
  return ReadResultSchema.parse({schema_version: 1, ...request, attempts, outcome: "failed", code,
    scope: policy.scope, recovery: policy.recovery, retry_after_ms: policy.recovery === "retry_later" ? retryAfterMs : null,
    metadata: {author: null, title: null, description: null, published_at: null}, evidence_kind: "none"});
}
async function authoritative(context: SourceReadContext, collectionId: string) {
  const principal = await context.revalidate?.();
  if (!principal || principal.accountId !== context.accountId || !principal.scopes.includes("collection:read") ||
    (!principal.isMember && !principal.isFilter)) throw new CollectionSourceReadError("permission_revoked", 403);
  return getCollectionStatus(context.getDatabase(), principal, {collection_id: collectionId});
}

export async function readCollectionSource(context: SourceReadContext, rawInput: unknown,
  dependencies?: SourceReadDependencies): Promise<OwnedReadResult> {
  const parsed = collectionSourceRequestSchema.safeParse(rawInput);
  if (!parsed.success || !SafeReferenceSchema.safeParse(context.runId).success) throw new CollectionSourceReadError("invalid_request", 400);
  const input = parsed.data;
  const base = {request_ref: context.runId, attempt_ref: input.attempt_ref};
  const owned = (value: ReadResult) => OwnedReadResultSchema.parse({...value, ...base, collection_id: input.collection_id});
  const evidenceMemory = dependencies?.memory ?? memory;
  let initial: CollectionStatusResult;
  try {initial = await authoritative(context, input.collection_id);}
  catch (error) {evidenceMemory.forget(context.accountId); throw error;}
  const identity = sourceReadIdentity(initial);
  if (!identity) {evidenceMemory.forget(context.accountId); return owned({schema_version: 1, ...base, attempts: [], outcome: "skipped",
    reason: initial.collection?.collection_status === "active" && initial.collection.moderation_status === "clear" &&
      initial.content?.enrichment_action === "reuse_summary" ? "already_ready" : "not_eligible"});}
  context.signal.throwIfAborted();
  const deps = dependencies ?? {read: readExternalSource, coordinator: createSourceReadCoordinator(context.getDatabase()), memory};
  const scope: SourceReadScope = {accountId: context.accountId, collectionId: input.collection_id, ...identity,
    attemptRef: input.attempt_ref, requestRef: context.runId};
  const key = fingerprint(JSON.stringify([input.collection_id, input.attempt_ref, identity.operation]));
  const budget = await deps.coordinator.consumeInvocation(scope);
  if (!budget.allowed) return owned(failed(base, "rate_limited", [], budget.retryAfterMs));
  const recheck = async () => {
    const current = sourceReadIdentity(await authoritative(context, input.collection_id));
    if (!current || current.operation !== identity.operation) throw new CollectionSourceReadError("permission_revoked", 403);
  };
  const finalize = async (value: ReadResult) => {
    try {context.signal.throwIfAborted(); await waitForResult(recheck(), AbortSignal.timeout(1000)); return owned(value);}
    catch {evidenceMemory.forget(context.accountId); return owned(failed(base, "permission_revoked", value.attempts));}
  };
  const cached = deps.memory.get(context.accountId, key);
  if (cached) return finalize(cached);
  const existing = deps.memory.inflight.get(context.accountId);
  if (existing) {
    if (existing.key !== key) return owned(failed(base, "rate_limited", [], 1000));
    // A duplicate cancellation only cancels its own wait. Owner cancellation/revocation aborts shared IO.
    return finalize(await waitForResult(existing.promise, context.signal));
  }
  const work = async (): Promise<ReadResult> => {
    const claim = await deps.coordinator.acquire(scope, true);
    if (!claim.allowed) return failed(base, "rate_limited", [], claim.retryAfterMs);
    const stop = new AbortController(), revoked = new AbortController();
    const signal = AbortSignal.any([context.signal, revoked.signal, AbortSignal.timeout(90_000)]);
    let invalidated = false;
    const monitor = (async () => {
      try {
        while (!stop.signal.aborted && !signal.aborted) {
          await delay(500, undefined, {signal: stop.signal});
          if (signal.aborted) break;
          const checkSignal = AbortSignal.any([stop.signal, signal, AbortSignal.timeout(1000)]);
          await waitForResult(recheck(), checkSignal);
          checkSignal.throwIfAborted();
          if (!await waitForResult(deps.coordinator.heartbeat(scope, claim.reference), checkSignal)) throw new Error("lease_lost");
        }
      } catch {
        if (!stop.signal.aborted) {invalidated = true; revoked.abort();}
      }
    })();
    let result: ReadResult | undefined;
    let dispatched = false;
    try {
      await recheck();
      dispatched = true;
      result = ReadResultSchema.parse(await deps.read({...base, url: identity.url, sourceKind: identity.sourceKind},
        {signal, admissionReference: claim.reference}));
      if (result.request_ref !== base.request_ref || result.attempt_ref !== base.attempt_ref) throw new FetcherClientError("invalid_fetcher_response");
      if (invalidated || signal.aborted) return failed(base, invalidated || context.signal.aborted ? "permission_revoked" : "network_timeout", result.attempts);
      await recheck();
      deps.memory.put(context.accountId, key, result);
      return result;
    } catch (error) {
      if (invalidated || context.signal.aborted || error instanceof CollectionSourceReadError || error instanceof CollectionStatusServiceError) {
        if (dispatched && !result) throw new CollectionSourceReadError("permission_revoked", 403);
        return failed(base, "permission_revoked", result?.attempts ?? []);
      }
      if (error instanceof FetcherClientError) throw error;
      throw new FetcherClientError(signal.aborted ? "fetcher_timeout" : "invalid_fetcher_response");
    } finally {
      stop.abort(); await monitor;
      await deps.coordinator.release(scope, claim.reference);
    }
  };
  const promise = work();
  deps.memory.inflight.set(context.accountId, {key, promise});
  try {return await finalize(await promise);}
  finally {if (deps.memory.inflight.get(context.accountId)?.promise === promise) deps.memory.inflight.delete(context.accountId);}
}

async function waitForResult<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {abort = () => reject(signal.reason); signal.addEventListener("abort", abort, {once: true});});
  try {return await Promise.race([promise, cancelled]);}
  finally {signal.removeEventListener("abort", abort);}
}
