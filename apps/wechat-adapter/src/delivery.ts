import type { AttentionChannelGateway } from "./attention-client.js";
import type {
  AsyncReplySender,
  ChannelGatewayReply,
  NormalizedWechatMessage,
  SafeLogger,
} from "./types.js";

interface DeliveryEntry {
  asyncScheduled: boolean;
  expiresAt: number;
  promise: Promise<ChannelGatewayReply>;
}

export interface DeliveryOutcome {
  text: string;
  timedOut: boolean;
}

export class MessageDeliveryCoordinator {
  private readonly entries = new Map<string, DeliveryEntry>();

  constructor(
    private readonly gateway: AttentionChannelGateway,
    private readonly options: {
      asyncSender: AsyncReplySender | null;
      logger: SafeLogger;
      maxEntries?: number;
      now?: () => number;
      syncTimeoutMs: number;
      ttlMs?: number;
    },
  ) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private prune(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
    const maxEntries = this.options.maxEntries ?? 5_000;
    while (this.entries.size >= maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.entries.delete(oldest);
    }
  }

  private entry(message: NormalizedWechatMessage): DeliveryEntry {
    this.prune();
    const existing = this.entries.get(message.channelMessageId);
    if (existing) return existing;
    const promise = this.gateway.send(message);
    const created = {
      asyncScheduled: false,
      expiresAt: this.now() + (this.options.ttlMs ?? 10 * 60 * 1_000),
      promise,
    };
    this.entries.set(message.channelMessageId, created);
    return created;
  }

  private scheduleAsync(
    entry: DeliveryEntry,
    openId: string,
  ): void {
    if (!this.options.asyncSender || entry.asyncScheduled) return;
    entry.asyncScheduled = true;
    void entry.promise
      .then(async (reply) => {
        if (reply.pendingRequestId) {
          return this.gateway.pollPending(reply.pendingRequestId);
        }
        return reply;
      })
      .then((reply) => this.options.asyncSender!.sendText(openId, reply.text))
      .then(() => this.options.logger.info("wechat_async_reply_sent"))
      .catch(() => this.options.logger.warn("wechat_async_reply_failed"));
  }

  async deliver(message: NormalizedWechatMessage): Promise<DeliveryOutcome> {
    const entry = this.entry(message);
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeout = new Promise<null>((resolve) => {
      timeoutHandle = setTimeout(() => resolve(null), this.options.syncTimeoutMs);
      timeoutHandle.unref();
    });
    try {
      const reply = await Promise.race([entry.promise, timeout]);
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (!reply) {
        this.scheduleAsync(entry, message.fromUser);
        return {
          text: this.options.asyncSender
            ? "已收到，处理完成后会通过客服消息回复。"
            : "处理仍在进行，请稍后重新发送本条消息查询结果。",
          timedOut: true,
        };
      }
      if (reply.pendingRequestId) this.scheduleAsync(entry, message.fromUser);
      return { text: reply.text, timedOut: false };
    } catch {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      this.entries.delete(message.channelMessageId);
      return { text: "暂时无法处理，请稍后重试。", timedOut: false };
    }
  }
}
