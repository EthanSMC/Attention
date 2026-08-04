import type {
  ChannelGatewayReply,
  NormalizedWechatMessage,
} from "./types.js";

export class AttentionGatewayError extends Error {
  constructor(
    readonly code: "gateway_invalid_response" | "gateway_rejected" | "gateway_unavailable",
    readonly retryable: boolean,
  ) {
    super(code);
    this.name = "AttentionGatewayError";
  }
}

interface ChannelPayload {
  bind_url?: unknown;
  error?: unknown;
  membership_url?: unknown;
  pending_request_id?: unknown;
  result?: unknown;
  status?: unknown;
}

function safeUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 4_096) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function completedText(result: unknown): string {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return "Attention 已完成处理，请在网页端查看结果。";
  }
  const record = result as Record<string, unknown>;
  if (typeof record.answer === "string" && record.answer.trim()) {
    return record.answer.trim().slice(0, 1_900);
  }
  const status = typeof record.status === "string" ? record.status : "completed";
  const messages: Record<string, string> = {
    accepted: "已收藏，内容整理会在后台继续。",
    already_collected: "这个链接已经在你的收藏中。",
    ambiguous: "识别到多个候选链接，请前往 Attention 网页选择。",
    invalid: "没有识别到可收藏的内容链接。",
    merged_with_existing_content: "已收藏，并关联到已有内容。",
    resolution_pending: "链接仍在安全解析中，请稍后在 Attention 查看。",
    unsafe: "链接未通过安全检查，未执行收藏。",
  };
  return messages[status] ?? "Attention 已完成处理，请在网页端查看结果。";
}

function parseChannelResponse(statusCode: number, payload: ChannelPayload): ChannelGatewayReply {
  const pendingRequestId = typeof payload.pending_request_id === "string" &&
    /^[0-9a-f-]{36}$/iu.test(payload.pending_request_id)
    ? payload.pending_request_id
    : null;
  if (payload.status === "binding_required") {
    const bindUrl = safeUrl(payload.bind_url);
    if (!bindUrl || !pendingRequestId) {
      throw new AttentionGatewayError("gateway_invalid_response", true);
    }
    return {
      pendingRequestId,
      status: "binding_required",
      text: `请先绑定 Attention 账号，完成后会继续处理本条消息：\n${bindUrl}`,
    };
  }
  if (payload.status === "membership_required") {
    const membershipUrl = safeUrl(payload.membership_url) ?? safeUrl(payload.bind_url);
    if (!membershipUrl || !pendingRequestId) {
      throw new AttentionGatewayError("gateway_invalid_response", true);
    }
    return {
      pendingRequestId,
      status: "membership_required",
      text: `微信 Channel 是 Member 能力，请开通并确认绑定后继续：\n${membershipUrl}`,
    };
  }
  if (statusCode >= 200 && statusCode < 300 && payload.status === "completed") {
    return {
      pendingRequestId: null,
      status: "completed",
      text: completedText(payload.result),
    };
  }
  throw new AttentionGatewayError("gateway_invalid_response", true);
}

async function readJsonResponse(response: Response): Promise<ChannelPayload> {
  const raw = await response.text();
  if (raw.length > 1_000_000) {
    throw new AttentionGatewayError("gateway_invalid_response", true);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new AttentionGatewayError("gateway_invalid_response", true);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new AttentionGatewayError("gateway_invalid_response", true);
  }
  return payload as ChannelPayload;
}

export interface AttentionChannelGateway {
  pollPending(pendingRequestId: string, signal?: AbortSignal): Promise<ChannelGatewayReply>;
  send(message: NormalizedWechatMessage): Promise<ChannelGatewayReply>;
}

export class HttpAttentionChannelGateway implements AttentionChannelGateway {
  constructor(
    private readonly config: {
      apiBaseUrl: string;
      apiSecret: string;
      pendingPollIntervalMs: number;
      pendingPollTimeoutMs: number;
    },
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.config.apiSecret}`,
      "content-type": "application/json",
    };
  }

  async send(message: NormalizedWechatMessage): Promise<ChannelGatewayReply> {
    let response: Response;
    try {
      response = await this.fetchImplementation(
        `${this.config.apiBaseUrl}/api/channels/messages`,
        {
          body: JSON.stringify({
            action: message.action,
            app_id: message.appId,
            channel_message_id: message.channelMessageId,
            provider: "wechat",
            raw_input: message.rawInput,
            subject_id: message.fromUser,
          }),
          headers: this.headers(),
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
        },
      );
    } catch {
      throw new AttentionGatewayError("gateway_unavailable", true);
    }
    const payload = await readJsonResponse(response);
    if (!response.ok && response.status !== 403) {
      throw new AttentionGatewayError("gateway_rejected", response.status >= 500);
    }
    return parseChannelResponse(response.status, payload);
  }

  async pollPending(
    pendingRequestId: string,
    signal: AbortSignal = AbortSignal.timeout(this.config.pendingPollTimeoutMs),
  ): Promise<ChannelGatewayReply> {
    if (!/^[0-9a-f-]{36}$/iu.test(pendingRequestId)) {
      throw new AttentionGatewayError("gateway_invalid_response", false);
    }
    while (!signal.aborted) {
      let response: Response;
      try {
        response = await this.fetchImplementation(
          `${this.config.apiBaseUrl}/api/channels/pending/${encodeURIComponent(pendingRequestId)}`,
          {
            headers: this.headers(),
            method: "GET",
            redirect: "error",
            signal,
          },
        );
      } catch {
        if (signal.aborted) break;
        throw new AttentionGatewayError("gateway_unavailable", true);
      }
      const payload = await readJsonResponse(response);
      if (response.status === 202 && payload.status === "pending") {
        await new Promise<void>((resolve) => {
          const finish = (): void => {
            clearTimeout(timeout);
            signal.removeEventListener("abort", finish);
            resolve();
          };
          const timeout = setTimeout(finish, this.config.pendingPollIntervalMs);
          timeout.unref();
          signal.addEventListener("abort", finish, { once: true });
        });
        continue;
      }
      if (response.ok && payload.status === "completed") {
        return {
          pendingRequestId: null,
          status: "completed",
          text: completedText(payload.result),
        };
      }
      throw new AttentionGatewayError("gateway_rejected", response.status >= 500);
    }
    throw new AttentionGatewayError("gateway_unavailable", true);
  }
}
