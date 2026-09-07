import "server-only";
import {randomUUID, timingSafeEqual} from "node:crypto";
import {z} from "zod";
import {setAccountContext, sql, type AttentionDatabase, type AttentionTransaction} from "@attention/db";
import type {ReadResult} from "@attention/content-reader-contracts";
import {SafeReferenceSchema} from "@attention/content-reader-contracts";
import {getWebDatabase} from "./db";
import {noStoreJson} from "./api-guard";
import {readJsonRequestWithinLimit, RequestBodyTooLargeError, InvalidRequestBodyError} from "./request-body";
import {getCollectionStatus} from "./collection-status-service";

export interface SourceReadScope {
  accountId: string; collectionId: string; operation: string; sourceFingerprint: string;
  attemptRef: string; requestRef: string;
}
export interface BrowserClaimInput {
  reference: string; request_ref: string; attempt_ref: string; source_fingerprint: string; renderer_ref: string;
}
export interface BrowserProof extends BrowserClaimInput {claim: string}
export interface BrowserScope {accountId: string; collectionId: string; operation: string; claim: string}
export type SourceClaim = {allowed: true; reference: string} | {allowed: false; retryAfterMs: number};
export class SourceReadCapacityError extends Error {
  readonly code = "rate_limited";
  constructor() {super("rate_limited");}
}

export function createSourceReadCoordinator(db: AttentionDatabase) {
  async function debit(tx: AttentionTransaction, scope: SourceReadScope): Promise<{allowed: boolean; retryAfterMs: number}> {
    await setAccountContext(tx, scope.accountId);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'source-read:' + scope.accountId}, 0))`);
    const rows = await tx.execute(sql`select minute_bucket = date_trunc('minute', clock_timestamp()) and minute_count >= 6 as limited,
      greatest(1, ceil(extract(epoch from (minute_bucket + interval '1 minute' - clock_timestamp())) * 1000)) as retry
      from source_read_accounts where account_id = ${scope.accountId}::uuid`);
    if (rows[0]?.limited) return {allowed: false, retryAfterMs: Math.min(60_000, Number(rows[0].retry))};
    await tx.execute(sql`insert into source_read_accounts (account_id, collection_id, operation, source_fingerprint,
      attempt_ref, request_ref, reference, lease_deadline, authorized_until, minute_bucket, minute_count, browser_consumed)
      values (${scope.accountId}::uuid, ${scope.collectionId}::uuid, ${scope.operation}, ${scope.sourceFingerprint}, ${scope.attemptRef},
        ${scope.requestRef}, ${randomUUID()}::uuid, clock_timestamp(), clock_timestamp(), date_trunc('minute', clock_timestamp()), 1, false)
      on conflict (account_id) do update set minute_bucket = excluded.minute_bucket,
        minute_count = case when source_read_accounts.minute_bucket = excluded.minute_bucket then source_read_accounts.minute_count + 1 else 1 end`);
    return {allowed: true, retryAfterMs: 0};
  }
  async function browser(action: string, input: BrowserClaimInput, claim: string | null = null): Promise<BrowserScope | null> {
    const rows = await db.execute(sql`select public.source_read_browser(${action}, ${input.reference}::uuid,
      ${input.request_ref}, ${input.attempt_ref}, ${input.source_fingerprint}, ${input.renderer_ref}, ${claim}::uuid) as result`);
    const result = (rows[0]?.result ?? null) as BrowserScope | {code: "rate_limited"} | null;
    if (result && "code" in result) throw new SourceReadCapacityError();
    return result;
  }
  return {
    consumeInvocation: (scope: SourceReadScope) => db.transaction(tx => debit(tx, scope)),
    async acquire(scope: SourceReadScope, invocationDebited = false): Promise<SourceClaim> {
      return db.transaction(async tx => {
        if (!invocationDebited) {const budget = await debit(tx, scope); if (!budget.allowed) return {allowed: false, retryAfterMs: budget.retryAfterMs};}
        await setAccountContext(tx, scope.accountId);
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'source-read:' + scope.accountId}, 0))`);
        const rows = await tx.execute(sql`select *,
          lease_deadline > clock_timestamp() as busy
          from source_read_accounts where account_id = ${scope.accountId}::uuid`);
        const prior = rows[0];
        if (prior?.busy) return {allowed: false, retryAfterMs: 1000};
        if (!prior) return {allowed: false, retryAfterMs: 1000};
        const reference = randomUUID();
        await tx.execute(sql`insert into source_read_accounts (account_id, collection_id, operation, source_fingerprint,
          attempt_ref, request_ref, reference, lease_deadline, authorized_until, minute_bucket, minute_count, browser_consumed)
          values (${scope.accountId}::uuid, ${scope.collectionId}::uuid, ${scope.operation}, ${scope.sourceFingerprint},
            ${scope.attemptRef}, ${scope.requestRef}, ${reference}::uuid, clock_timestamp() + interval '90 seconds',
            clock_timestamp() + interval '2 seconds', date_trunc('minute', clock_timestamp()), 1, false)
          on conflict (account_id) do update set collection_id = excluded.collection_id, operation = excluded.operation,
            source_fingerprint = excluded.source_fingerprint, attempt_ref = excluded.attempt_ref, request_ref = excluded.request_ref,
            reference = excluded.reference, lease_deadline = excluded.lease_deadline, authorized_until = excluded.authorized_until,
            browser_consumed = false`);
        return {allowed: true, reference};
      });
    },
    async heartbeat(scope: SourceReadScope, reference: string): Promise<boolean> {
      return db.transaction(async tx => {
        await setAccountContext(tx, scope.accountId);
        const rows = await tx.execute(sql`update source_read_accounts set authorized_until = least(lease_deadline, clock_timestamp() + interval '2 seconds')
          where account_id = ${scope.accountId}::uuid and reference = ${reference}::uuid and operation = ${scope.operation}
            and lease_deadline > clock_timestamp() and authorized_until > clock_timestamp() returning reference`);
        return rows.length === 1;
      });
    },
    async release(scope: SourceReadScope, reference: string): Promise<void> {
      await db.transaction(async tx => {
        await setAccountContext(tx, scope.accountId);
        await tx.execute(sql`update source_read_accounts set lease_deadline = clock_timestamp(), authorized_until = clock_timestamp()
          where account_id = ${scope.accountId}::uuid and reference = ${reference}::uuid`);
      });
    },
    browserInspect: (input: BrowserClaimInput) => browser("inspect", input),
    browserClaim: (input: BrowserClaimInput) => browser("consume", input),
    browserStatus: (input: BrowserProof) => browser("status", input, input.claim),
    browserRelease: async (input: BrowserProof) => (await browser("release", input, input.claim)) !== null,
  };
}
export type SourceReadCoordinator = ReturnType<typeof createSourceReadCoordinator>;

const admissionInput = z.object({reference: z.string().uuid(), request_ref: SafeReferenceSchema, attempt_ref: SafeReferenceSchema,
  source_fingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  renderer_ref: z.string().regex(/^attention-reader-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u),
}).strict();
const admissionProof = admissionInput.extend({claim: z.string().uuid()});

/** Authenticated infrastructure only. A supplied reference never becomes an account ID. */
export async function handleReaderAdmission(request: Request, action: "consume" | "status" | "release",
  deps: {getDatabase(): AttentionDatabase; secret: string | undefined} = {
    getDatabase: getWebDatabase, secret: process.env.ATTENTION_READER_COORDINATOR_SECRET,
  }): Promise<Response> {
  const secret = deps.secret;
  const actual = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret ?? ""}`);
  if (!secret || secret.length < 32 || actual.length !== expected.length || !timingSafeEqual(actual, expected))
    return noStoreJson({error: {code: "unauthorized"}}, {status: 401});
  try {
    const input = (action === "consume" ? admissionInput : admissionProof).parse(await readJsonRequestWithinLimit(request, 4096));
    const db = deps.getDatabase(), coordinator = createSourceReadCoordinator(db);
    if (action === "release") {
      const released = await coordinator.browserRelease(admissionProof.parse(input));
      return noStoreJson({released}, {status: released ? 200 : 409});
    }
    const scope = action === "consume" ? await coordinator.browserInspect(input) : await coordinator.browserStatus(admissionProof.parse(input));
    if (!scope) return noStoreJson({active: false}, {status: 409});
    // Every transport uses the same Core identity and eligibility decision.
    const {sourceReadIdentity} = await import("./collection-source-reader");
    const identity = sourceReadIdentity(await getCollectionStatus(db, {accountId: scope.accountId}, {collection_id: scope.collectionId}));
    if (!identity || identity.operation !== scope.operation || identity.sourceFingerprint !== input.source_fingerprint)
      return noStoreJson({active: false}, {status: 409});
    if (action === "status") {
      const active = await coordinator.browserStatus(admissionProof.parse(input));
      return noStoreJson({active: active !== null});
    }
    const claimed = await coordinator.browserClaim(input);
    return claimed ? noStoreJson({claim: claimed.claim}) : noStoreJson({active: false}, {status: 409});
  } catch (error) {
    if (error instanceof SourceReadCapacityError) return noStoreJson({code: "rate_limited", retry_after_ms: 1000}, {status: 429});
    const malformed = error instanceof z.ZodError || error instanceof InvalidRequestBodyError || error instanceof RequestBodyTooLargeError;
    return noStoreJson({error: {code: malformed ? "invalid_request" : "admission_unavailable"}}, {status: malformed ? 400 : 503});
  }
}

/** One completed entry/account; expire at 120 seconds and evict oldest entries at the global byte bound. */
export class SourceReadMemory {
  readonly inflight = new Map<string, {key: string; promise: Promise<ReadResult>}>();
  private readonly entries = new Map<string, {key: string; value: ReadResult; expires: number; bytes: number; timer: ReturnType<typeof setTimeout>}>();
  private bytes = 0;
  constructor(private readonly now = Date.now, private readonly maxBytes = 4 * 1024 * 1024) {}
  forget(accountId: string): void {this.remove(accountId);}
  private remove(accountId: string): void {
    const entry = this.entries.get(accountId);
    if (entry) {clearTimeout(entry.timer); this.bytes -= entry.bytes; this.entries.delete(accountId);}
  }
  get(accountId: string, key: string): ReadResult | null {
    const entry = this.entries.get(accountId);
    if (!entry) return null;
    if (entry.expires <= this.now() || entry.key !== key) {this.remove(accountId); return null;}
    return structuredClone(entry.value);
  }
  put(accountId: string, key: string, value: ReadResult): void {
    this.remove(accountId);
    for (const [id, entry] of this.entries) if (entry.expires <= this.now()) this.remove(id);
    const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
    if (bytes > this.maxBytes) return;
    while (this.bytes + bytes > this.maxBytes && this.entries.size) this.remove(this.entries.keys().next().value!);
    const timer = setTimeout(() => this.remove(accountId), 120_000); timer.unref();
    this.entries.set(accountId, {key, value: structuredClone(value), expires: this.now() + 120_000, bytes, timer});
    this.bytes += bytes;
  }
}
