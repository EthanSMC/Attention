import { z } from "zod";

export const MAX_FRAME_BYTES = 3 * 1024 * 1024;
export const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
export const RESOURCE_TYPES = ["document", "script", "stylesheet", "fetch", "xhr"] as const;
const id = z.string().regex(/^[1-9][0-9]{0,2}$/u);
const url = z.string().min(1).max(4_096).refine(value => {
  try { const parsed = new URL(value); return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password; }
  catch { return false; }
});
const code = z.enum(["blocked", "limit_exceeded", "network_error", "protocol_error", "render_failed", "cancelled"]);
export const FrameSchema = z.discriminatedUnion("kind", [
  z.object({kind: z.literal("start"), url, sourceKind: z.enum(["generic_web", "wechat_official_article", "xiaohongshu", "douyin"])}).strict(),
  z.object({kind: z.literal("resource"), id, url, resourceType: z.enum(RESOURCE_TYPES)}).strict(),
  z.object({kind: z.literal("resource_result"), id, status: z.number().int().min(200).max(599),
    contentType: z.string().min(1).max(256).regex(/^[\x20-\x7e]+$/u), finalUrl: url,
    bodyBase64: z.string().max(2_796_204).refine(value => value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/u.test(value) &&
      Buffer.from(value, "base64").length <= MAX_SNAPSHOT_BYTES && Buffer.from(value, "base64").toString("base64") === value),
  }).strict(),
  z.object({kind: z.literal("resource_error"), id, code}).strict(),
  z.object({kind: z.literal("complete"), html: z.string().max(MAX_SNAPSHOT_BYTES).refine(value => Buffer.byteLength(value) <= MAX_SNAPSHOT_BYTES),
    finalUrl: url, status: z.number().int().min(200).max(599)}).strict(),
  z.object({kind: z.literal("failed"), code}).strict(),
]);
export type Frame = z.infer<typeof FrameSchema>;
export type ResourceFrame = Extract<Frame, {kind: "resource"}>;
export type ResourceReply = Extract<Frame, {kind: "resource_result" | "resource_error"}>;

export class ProtocolError extends Error { constructor() { super("Invalid renderer protocol"); } }
export class WireBudget {
  private used = 0;
  charge(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || (this.used += bytes) > 20 * 1024 * 1024) throw new ProtocolError();
  }
}
export class FrameDecoder {
  private pending = Buffer.alloc(0);
  constructor(private readonly budget: WireBudget) {}
  push(chunk: Uint8Array): Frame[] {
    this.budget.charge(chunk.byteLength);
    // Never concatenate an unbounded chunk into a pending frame.
    const frames: Frame[] = [];
    let start = 0;
    for (let index = 0; index < chunk.length; index++) {
      if (chunk[index] !== 10) continue;
      const segment = chunk.subarray(start, index);
      if (this.pending.length + segment.length > MAX_FRAME_BYTES) throw new ProtocolError();
      try {
        frames.push(FrameSchema.parse(JSON.parse(new TextDecoder("utf-8", {fatal: true})
          .decode(Buffer.concat([this.pending, segment])))));
      } catch { throw new ProtocolError(); }
      this.pending = Buffer.alloc(0);
      start = index + 1;
    }
    if (this.pending.length + chunk.length - start > MAX_FRAME_BYTES) throw new ProtocolError();
    this.pending = Buffer.concat([this.pending, chunk.subarray(start)]);
    return frames;
  }
  finish(): void { if (this.pending.length) throw new ProtocolError(); }
}
export function encodeFrame(frame: unknown, budget: WireBudget): Buffer {
  let parsed: Frame;
  try { parsed = FrameSchema.parse(frame); } catch { throw new ProtocolError(); }
  const bytes = Buffer.from(JSON.stringify(parsed) + "\n");
  if (bytes.length > MAX_FRAME_BYTES) throw new ProtocolError();
  budget.charge(bytes.length);
  return bytes;
}
