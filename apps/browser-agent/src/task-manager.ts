import { createHash, randomUUID } from "node:crypto";
import {
  BROWSER_ACTION_TIMEOUT_MS, BROWSER_TASK_TTL_MS, MAX_BODY_BYTES, BrowserGrantSchema,
  BrowserOpenInputSchema, BrowserTaskError, BrowserTaskInputSchema, BrowserTaskResultSchema,
  type BrowserGrant, type BrowserTaskResult,
} from "./contracts.js";

/** Authority comes from the configured Attention service, never page/model fields. */
export interface BrowserAuthority {
  resolve(grant: string, signal: AbortSignal): Promise<BrowserGrant>;
}
export interface BrowserDocument {
  url: string;
  title: string;
  text: string;
  verificationRequired: boolean;
  complete: boolean;
}
export interface BrowserPage {
  read(signal: AbortSignal): Promise<BrowserDocument>;
  scroll(signal: AbortSignal): Promise<void>;
  show(signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}
export interface BrowserEngine {
  open(grant: BrowserGrant, signal: AbortSignal): Promise<BrowserPage>;
  close(): Promise<void>;
}
interface Task {
  id: string;
  token: string;
  grant: BrowserGrant;
  page: BrowserPage;
  controller: AbortController;
  status: BrowserTaskResult["status"];
  expiresAt: number;
  lastReadAt: number | null;
  readCount: number;
  timer: ReturnType<typeof setTimeout>;
}
function identity(grant: BrowserGrant): string {
  return JSON.stringify([grant.grant_id, grant.account_id, grant.collection_id, grant.source_revision, grant.source_url]);
}
export async function bounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void operation.catch(() => {}); throw signal.reason; }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** One profile/one article at a time. Rejected parallel work is never secretly queued. */
export class BrowserTaskManager {
  private task: Task | null = null;
  private busy = false;
  private stopped = false;
  private readonly lifetime = new AbortController();
  constructor(private readonly authority: BrowserAuthority, private readonly engine: BrowserEngine,
    private readonly now: () => number = Date.now, private readonly timeoutMs = BROWSER_ACTION_TIMEOUT_MS) {}

  private async action<T>(run: (signal: AbortSignal) => Promise<T>, task?: Task): Promise<T> {
    if (this.stopped) throw new BrowserTaskError("browser_unavailable");
    if (this.busy) throw new BrowserTaskError("browser_busy");
    this.busy = true;
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const signal = AbortSignal.any([deadline, this.lifetime.signal, ...(task ? [task.controller.signal] : [])]);
    try { return await bounded(run(signal), signal); }
    catch (error) {
      if (deadline.aborted) {
        // Fail closed: aborting a tool cannot leave a late page alive or reusable.
        if (task && this.task === task) await this.discard(task);
        throw new BrowserTaskError("browser_timeout");
      }
      if (error instanceof BrowserTaskError) throw error;
      if (signal.aborted) throw new BrowserTaskError("cancelled");
      throw new BrowserTaskError("browser_unavailable");
    } finally { this.busy = false; }
  }

  private async authorize(token: string, signal: AbortSignal): Promise<BrowserGrant> {
    let grant: BrowserGrant;
    try { grant = BrowserGrantSchema.parse(await bounded(this.authority.resolve(token, signal), signal)); }
    catch { signal.throwIfAborted(); throw new BrowserTaskError("permission_revoked"); }
    signal.throwIfAborted();
    if (grant.expires_at <= this.now()) throw new BrowserTaskError("task_expired");
    return grant;
  }

  private async recheck(task: Task, signal: AbortSignal): Promise<void> {
    try {
      if (this.task !== task || task.controller.signal.aborted) throw new BrowserTaskError("cancelled");
      if (task.expiresAt <= this.now()) throw new BrowserTaskError("task_expired");
      const current = await this.authorize(task.token, signal);
      if (identity(current) !== identity(task.grant)) throw new BrowserTaskError("source_changed");
      // A service cannot extend an existing task by returning a longer TTL.
      task.expiresAt = Math.min(task.expiresAt, current.expires_at);
    } catch (error) {
      await this.discard(task, error instanceof BrowserTaskError ? error : new BrowserTaskError("permission_revoked"));
      throw error;
    }
  }

  private view(task: Task): BrowserTaskResult {
    return { task_id: task.id, collection_id: task.grant.collection_id,
      source_revision: task.grant.source_revision, status: task.status,
      expires_at: task.expiresAt, last_read_at: task.lastReadAt, read_count: task.readCount };
  }
  private get(raw: unknown): Task {
    const input = BrowserTaskInputSchema.safeParse(raw);
    if (!input.success) throw new BrowserTaskError("invalid_request");
    if (!this.task || this.task.id !== input.data.task_id) throw new BrowserTaskError("task_not_found");
    return this.task;
  }
  private async discard(task: Task, reason = new BrowserTaskError("cancelled")): Promise<void> {
    if (this.task === task) this.task = null;
    clearTimeout(task.timer);
    task.controller.abort(reason);
    task.token = "";
    await bounded(task.page.close(), AbortSignal.timeout(1000)).catch(() => {});
  }

  async open(raw: unknown): Promise<BrowserTaskResult> {
    const input = BrowserOpenInputSchema.safeParse(raw);
    if (!input.success) throw new BrowserTaskError("invalid_request");
    return this.action(async signal => {
      const grant = await this.authorize(input.data.grant, signal);
      if (this.task) {
        if (identity(this.task.grant) === identity(grant)) {
          await this.recheck(this.task, signal);
          return this.view(this.task);
        }
        // Replace only after successful authority validation; unauthorized opens
        // cannot evict the owner's active verification window.
        await this.discard(this.task);
      }
      const opening = this.engine.open(grant, signal).then(async page => {
        if (signal.aborted) { await page.close().catch(() => {}); signal.throwIfAborted(); }
        return page;
      });
      const page = await bounded(opening, signal);
      try {
        const current = await this.authorize(input.data.grant, signal);
        if (identity(current) !== identity(grant)) throw new BrowserTaskError("source_changed");
        const expiresAt = Math.min(grant.expires_at, current.expires_at, this.now() + BROWSER_TASK_TTL_MS);
        const task: Task = { id: randomUUID(), token: input.data.grant, grant, page,
          controller: new AbortController(), status: "opened", expiresAt, lastReadAt: null, readCount: 0,
          timer: setTimeout(() => { void this.discard(task); }, Math.max(1, expiresAt - this.now())) };
        task.timer.unref();
        this.task = task;
        return this.view(task);
      } catch (error) { await bounded(page.close(), AbortSignal.timeout(1000)).catch(() => {}); throw error; }
    });
  }

  async status(raw: unknown): Promise<BrowserTaskResult> {
    const task = this.get(raw);
    return this.action(async signal => { await this.recheck(task, signal); return this.view(task); }, task);
  }

  async read(raw: unknown): Promise<BrowserTaskResult> {
    const task = this.get(raw);
    return this.action(async signal => {
      await this.recheck(task, signal);
      const doc = await bounded(task.page.read(signal), signal);
      await this.recheck(task, signal);
      task.lastReadAt = this.now(); task.readCount++;
      if (doc.verificationRequired) {
        task.status = "needs_user_verification";
        return this.view(task); // Never return challenge text, URLs or tokens as evidence.
      }
      // Only the authoritative article itself may supply evidence. A challenge
      // or unexpected navigation cannot replace the source just by having text.
      const expected = new URL(task.grant.source_url), actual = new URL(doc.url);
      expected.hash = ""; actual.hash = "";
      if (actual.toString() !== expected.toString()) throw new BrowserTaskError("unsafe_source");
      const text = doc.text.trim(), title = doc.title.trim();
      if (!text || Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES || title.length > 500) {
        task.status = "incomplete";
        return this.view(task);
      }
      task.status = doc.complete ? "ready" : "incomplete";
      return BrowserTaskResultSchema.parse({ ...this.view(task), evidence: {
        title, text, sha256: createHash("sha256").update(text).digest("hex"),
        source_url: expected.toString(), visibility: "account_private", complete: doc.complete,
      } });
    }, task);
  }

  async interact(raw: unknown, action: "show" | "scroll"): Promise<BrowserTaskResult> {
    const task = this.get(raw);
    return this.action(async signal => {
      await this.recheck(task, signal);
      await bounded(task.page[action](signal), signal);
      await this.recheck(task, signal);
      return this.view(task); // Displaying/scrolling is not a successful read.
    }, task);
  }

  async close(raw: unknown): Promise<BrowserTaskResult> {
    const task = this.get(raw);
    // Cancellation must work while a long action is pending.
    await this.discard(task); task.status = "closed";
    return this.view(task);
  }

  async shutdown(): Promise<void> {
    this.stopped = true; this.lifetime.abort();
    if (this.task) await this.discard(this.task);
    await bounded(this.engine.close(), AbortSignal.timeout(2000)).catch(() => {});
  }
}
