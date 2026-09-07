import {randomUUID} from "node:crypto";
import {beforeAll, afterAll, describe, expect, it, vi} from "vitest";
import {createDatabase, setAccountContext, sql, type DatabaseHandle} from "@attention/db";
import {migrateDatabase} from "@attention/db/migrate";
import * as coordination from "./source-read-coordinator";
import type {ReadResult} from "@attention/content-reader-contracts";

describe("bounded source evidence memory", () => {
  it("actively removes expired evidence even without another clock read or cache request", async () => {
    vi.useFakeTimers();
    try {
      const cache = new coordination.SourceReadMemory(() => 0);
      cache.put("one", "key", {schema_version: 1, request_ref: "r", attempt_ref: "a", attempts: [], outcome: "skipped", reason: "already_ready"});
      await vi.advanceTimersByTimeAsync(120_000);
      expect(cache.get("one", "key")).toBeNull();
    } finally {vi.useRealTimers();}
  });
  it("expires after 120 seconds, replaces each account entry and evicts by UTF-8 bytes globally", () => {
    expect(coordination).toHaveProperty("SourceReadMemory");
    let now = 1000;
    const cache = new coordination.SourceReadMemory(() => now, 300);
    const result: ReadResult = {schema_version: 1, request_ref: "r", attempt_ref: "a", attempts: [], outcome: "skipped", reason: "already_ready"};
    cache.put("one", "first", result);
    cache.put("one", "second", {...result, request_ref: "new"});
    expect(cache.get("one", "second")).toMatchObject({request_ref: "new"});
    cache.put("two", "second", result); cache.put("three", "third", result);
    expect(cache.get("one", "second")).toBeNull();
    expect(cache.get("three", "third")).not.toBeNull();
    now += 120_000;
    expect(cache.get("three", "third")).toBeNull();
    cache.put("one", "large", {...result, request_ref: "界".repeat(128)});
    expect(cache.get("one", "large")).toBeNull();
  });
});

const databaseUrl = process.env.TEST_READER_DATABASE_URL;
describe.skipIf(!databaseUrl)("source reader shared coordination with non-owner Web role", () => {
  let owner: DatabaseHandle;
  let web: DatabaseHandle;
  let coordinator: typeof coordination;
  const accountId = randomUUID();
  const secondAccountId = randomUUID();
  const collectionId = randomUUID();
  const scope = {accountId, collectionId, operation: "a".repeat(64), sourceFingerprint: "b".repeat(64),
    attemptRef: "attempt-1", requestRef: "request-1"};
  beforeAll(async () => {
    owner = createDatabase(databaseUrl!);
    await migrateDatabase(owner.db);
    await owner.sql`insert into accounts (id, stable_handle, display_name, status)
      values (${accountId}, ${`reader${accountId.slice(0,8)}`}, 'Reader fixture', 'active'),
      (${secondAccountId}, ${`reader${secondAccountId.slice(0,8)}`}, 'Second fixture', 'active')`;
    await owner.sql.unsafe("CREATE ROLE reader_fixture_web LOGIN IN ROLE attention_web_runtime");
    const url = new URL(databaseUrl!); url.username = "reader_fixture_web";
    web = createDatabase(url.toString());
    coordinator = await import("./source-read-coordinator").catch(() => undefined) as typeof coordinator;
  }, 120_000);
  afterAll(async () => {await web?.close(); await owner?.close();});
  it("enforces account RLS and denies direct physical-slot or public function access", async () => {
    const coordinator = coordination.createSourceReadCoordinator(web.db);
    const fixtureClaim = await coordinator.acquire(scope);
    expect(fixtureClaim.allowed).toBe(true);
    expect(await owner.sql`select account_id from source_read_accounts where account_id = ${accountId}`).toHaveLength(1);
    expect(await web.db.transaction(async tx => {
      await setAccountContext(tx, secondAccountId);
      return tx.execute(sql`select * from source_read_accounts where account_id = ${accountId}::uuid`);
    })).toHaveLength(0);
    await expect(web.sql`select * from source_read_browser_slots`).rejects.toMatchObject({code: "42501"});
    await owner.sql.unsafe("CREATE ROLE reader_fixture_guest LOGIN");
    const url = new URL(databaseUrl!); url.username = "reader_fixture_guest";
    const guest = createDatabase(url.toString());
    try {await expect(guest.sql`select public.source_read_browser('inspect', ${randomUUID()}::uuid, 'r', 'a', ${"b".repeat(64)}, ${`attention-reader-${randomUUID()}`}, null)`)
      .rejects.toMatchObject({code: "42501"});}
    finally {await guest.close();}
    if (fixtureClaim.allowed) await coordinator.release(scope, fixtureClaim.reference);
  });
  it("atomically allows one account owner, independent accounts, six per DB minute and fences stale release", async () => {
    expect(coordinator).toBeDefined();
    const a = coordinator.createSourceReadCoordinator(web.db);
    const b = coordinator.createSourceReadCoordinator(web.db);
    const claims = await Promise.all([a.acquire(scope), b.acquire(scope)]);
    expect(claims.filter(x => x.allowed)).toHaveLength(1);
    const claim = claims.find(x => x.allowed)!;
    if (!claim.allowed) throw new Error("missing claim");
    expect(await b.acquire({...scope, accountId: secondAccountId})).toMatchObject({allowed: true});
    await a.release(scope, claim.reference);
    await owner.sql`update source_read_accounts set minute_bucket = clock_timestamp() - interval '1 minute' where account_id = ${accountId}`;
    for (let i = 0; i < 6; i++) {
      const next = await b.acquire(scope); expect(next.allowed).toBe(true);
      if (next.allowed) await b.release(scope, next.reference);
    }
    expect(await a.acquire(scope)).toMatchObject({allowed: false});
    await owner.sql`update source_read_accounts set minute_bucket = clock_timestamp() - interval '1 minute', lease_deadline = clock_timestamp() - interval '1 second' where account_id = ${accountId}`;
    const next = await b.acquire(scope); expect(next.allowed).toBe(true);
    await a.release(scope, claim.reference);
    expect(await a.acquire(scope)).toMatchObject({allowed: false});
    const rows = await owner.sql`select * from source_read_accounts where account_id = ${accountId}`;
    expect(Object.keys(rows[0]!)).not.toEqual(expect.arrayContaining(["url", "body", "temporary_text"]));
    if (next.allowed) await b.release(scope, next.reference);
  });
  it("quarantines two physical renderer slots across expired source owners and rejects forged cleanup", async () => {
    expect(coordinator).toBeDefined();
    const c = coordinator.createSourceReadCoordinator(web.db);
    await owner.sql`update source_read_accounts set minute_bucket = clock_timestamp() - interval '1 minute', lease_deadline = clock_timestamp() - interval '1 second'`;
    const first = await c.acquire(scope); const second = await c.acquire({...scope, accountId: secondAccountId});
    if (!first.allowed || !second.allowed) throw new Error("missing source lease");
    const input = (reference: string) => ({reference, request_ref: "request-1", attempt_ref: "attempt-1",
      source_fingerprint: "b".repeat(64), renderer_ref: `attention-reader-${randomUUID()}`});
    const one = input(first.reference); const two = input(second.reference);
    const slot1 = await c.browserClaim(one); const slot2 = await c.browserClaim(two);
    expect(slot1).not.toBeNull(); expect(slot2).not.toBeNull();
    expect(await c.browserClaim(one)).toBeNull();
    const thirdAccount = randomUUID();
    await owner.sql`insert into accounts (id, stable_handle) values (${thirdAccount}, ${`capacity${thirdAccount}`})`;
    const capacity = await c.acquire({...scope, accountId: thirdAccount});
    if (!capacity.allowed) throw new Error("missing capacity lease");
    await expect(c.browserClaim(input(capacity.reference))).rejects.toMatchObject({code: "rate_limited"});
    await owner.sql`update source_read_accounts set lease_deadline = clock_timestamp() - interval '1 second', minute_bucket = clock_timestamp() - interval '1 minute'`;
    expect(await c.browserStatus({...one, claim: slot1!.claim})).toBeNull();
    const third = await c.acquire(scope); if (!third.allowed) throw new Error("missing replacement");
    expect(await c.browserClaim(input(third.reference))).toBeNull();
    expect(await c.browserRelease({...one, claim: randomUUID()})).toBe(false);
    expect(await c.browserRelease({...one, claim: slot1!.claim})).toBe(true);
    const replacementInput = input(third.reference);
    const replacementSlot = await c.browserClaim(replacementInput);
    expect(replacementSlot).not.toBeNull();
    await c.browserRelease({...replacementInput, claim: replacementSlot!.claim});
    await c.browserRelease({...two, claim: slot2!.claim});
  });
  it("rolls back cancelled acquisition waiting for a DB lock and fences late heartbeat/release from a replacement", async () => {
    const c = coordination.createSourceReadCoordinator(web.db);
    await owner.sql`update source_read_accounts set minute_bucket = clock_timestamp() - interval '1 minute', lease_deadline = clock_timestamp() - interval '1 second' where account_id = ${accountId}`;
    const old = await c.acquire(scope); if (!old.allowed) throw new Error("old lease missing");
    await c.release(scope, old.reference);
    let unlock!: () => void, locked!: () => void;
    const lockReady = new Promise<void>(resolve => {locked = resolve;});
    const hold = new Promise<void>(resolve => {unlock = resolve;});
    const blocker = owner.db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'source-read:' + accountId}, 0))`);
      locked(); await hold;
    });
    await lockReady;
    const cancellation = new AbortController();
    // Optional signal is the production boundary under test; old implementation ignores it.
    const acquire = c.acquire as (input: typeof scope, debited: boolean, signal?: AbortSignal) => ReturnType<typeof c.acquire>;
    const late = acquire(scope, true, cancellation.signal).catch(error => error as unknown);
    await new Promise(resolve => setTimeout(resolve, 100)); cancellation.abort(); unlock(); await blocker;
    expect(await late).not.toMatchObject({allowed: true});
    const current = await c.acquire(scope); expect(current.allowed).toBe(true);
    if (!current.allowed) throw new Error("replacement missing");
    const expiredReference = old.reference;
    expect(await c.heartbeat(scope, expiredReference)).toBe(false);
    await c.release(scope, expiredReference);
    expect(await c.heartbeat(scope, current.reference)).toBe(true);
    await c.release(scope, current.reference);
  });
  it("cannot apply a blocked old heartbeat or release to a replacement nonce", async () => {
    const c = coordination.createSourceReadCoordinator(web.db);
    await owner.sql`update source_read_accounts set minute_bucket = clock_timestamp() - interval '1 minute', lease_deadline = clock_timestamp() - interval '1 second' where account_id = ${accountId}`;
    const claim = await c.acquire(scope); if (!claim.allowed) throw new Error("claim missing");
    const replacement = randomUUID();
    let unlock!: () => void, locked!: () => void;
    const lockReady = new Promise<void>(resolve => {locked = resolve;});
    const hold = new Promise<void>(resolve => {unlock = resolve;});
    const blocker = owner.db.transaction(async tx => {
      await tx.execute(sql`select reference from source_read_accounts where account_id = ${accountId}::uuid for update`);
      locked(); await hold;
      // Controlled replacement while the real runtime-role UPDATE is blocked on this row.
      await tx.execute(sql`update source_read_accounts set reference = ${replacement}::uuid,
        authorized_until = clock_timestamp() + interval '2 seconds' where account_id = ${accountId}::uuid`);
    });
    await lockReady;
    const cancellation = new AbortController();
    const heartbeat = c.heartbeat(scope, claim.reference, cancellation.signal).catch(() => false);
    await new Promise(resolve => setTimeout(resolve, 100)); cancellation.abort(); unlock(); await blocker;
    expect(await heartbeat).toBe(false);
    await c.release(scope, claim.reference);
    expect(await c.heartbeat(scope, replacement)).toBe(true);
    await c.release(scope, replacement);
  });
});
