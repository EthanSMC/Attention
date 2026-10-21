/** Transport-owned scheduling only: one Agent operation, while the receiver
 * continues persisting messages. Never holds a second thread invocation. */
export class SerialBackgroundWork {
  private active: Promise<void> | null = null;
  private failure: unknown;
  private failed = false;
  private stopped = false;
  get running() { return this.active !== null; }
  kick(work: () => Promise<void>) {
    this.throwIfFailed();
    if (this.active || this.stopped) return;
    this.active = Promise.resolve().then(work).catch(error => { this.failure = error; this.failed = true; }).finally(() => { this.active = null; });
  }
  throwIfFailed() { if (this.failed) throw this.failure; }
  /** Let already-finishing local work flush without coupling long Agent work
   * to reception. This is a bounded scheduling quantum, never a turn wait. */
  async settleWithin(milliseconds = 25) {
    if (!this.active) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([this.active, new Promise<void>(resolve => { timer = setTimeout(resolve, milliseconds); })]); }
    finally { if (timer) clearTimeout(timer); }
    this.throwIfFailed();
  }
  async drain() { this.stopped = true; await this.active; this.throwIfFailed(); }
}
