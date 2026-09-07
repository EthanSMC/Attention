import { FrameSchema, ProtocolError, type ResourceFrame, type ResourceReply } from "@attention/reader-browser/protocol";
import { safeFetchResource } from "./safe-fetch.js";
import { assertNoHttpsDowngrade, parseAndValidateUrl, type SourceKind } from "./url-policy.js";

export class ResourceBroker {
  private readonly ids = new Set<string>();
  private readonly pending = new Set<Promise<ResourceReply>>();
  private readonly controller = new AbortController();
  private readonly signal: AbortSignal;
  private bytes = 0;
  private reserved = 0;
  private readonly documents = new Map<string, number>();
  constructor(private readonly sourceKind: SourceKind, signal: AbortSignal,
    private readonly fetchResource: typeof safeFetchResource = safeFetchResource) {
    this.signal = AbortSignal.any([signal, this.controller.signal]);
  }
  async read(input: ResourceFrame): Promise<ResourceReply> {
    const frame = FrameSchema.parse(input);
    if (frame.kind !== "resource" || this.ids.has(frame.id) || this.ids.size >= 100 || this.pending.size >= 4 || this.bytes + this.reserved >= 20 * 1024 * 1024) throw new ProtocolError();
    this.signal.throwIfAborted();
    this.ids.add(frame.id);
    const initial = parseAndValidateUrl(frame.url, this.sourceKind);
    const reservation = Math.min(2 * 1024 * 1024, 20 * 1024 * 1024 - this.bytes - this.reserved);
    this.reserved += reservation;
    const operation = (async (): Promise<ResourceReply> => {
      const result = await this.fetchResource(frame.url, this.sourceKind, {signal: this.signal,
        maxBytes: reservation});
      this.signal.throwIfAborted();
      this.bytes += result.bytes.byteLength;
      if (this.bytes > 20 * 1024 * 1024 || result.bytes.byteLength > 2 * 1024 * 1024) throw new ProtocolError();
      const final = parseAndValidateUrl(result.finalUrl, this.sourceKind);
      assertNoHttpsDowngrade(initial, final);
      if (frame.resourceType === "document") this.documents.set(final.toString(), result.status);
      return FrameSchema.parse({kind: "resource_result", id: frame.id, status: result.status,
        contentType: result.contentType ?? "application/octet-stream", finalUrl: final.toString(),
        bodyBase64: Buffer.from(result.bytes).toString("base64")}) as ResourceReply;
    })();
    this.pending.add(operation);
    try { return await operation; } finally { this.pending.delete(operation); this.reserved -= reservation; }
  }
  async close(): Promise<void> {
    this.controller.abort();
    await Promise.allSettled(this.pending);
  }
  documentStatus(url: string): number | undefined { return this.documents.get(url); }
}
