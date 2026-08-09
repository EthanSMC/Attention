/**
 * Minimal fetch-based client for the official Tencent iLink bot API.
 *
 * Ported from the Python PoC on the orphan `wechat-adapter` branch
 * (`ilink_bot.py`; protocol extracted from the AstrBot `weixin_oc` adapter).
 * Only what the bridge needs is implemented: QR login, QR status polling,
 * long-poll message receive, and text send.
 */

import {
  ILINK_APP_CLIENT_VERSION_HEADER,
  ILINK_BASE_URL,
  ILINK_BOT_TYPE,
  ILINK_CHANNEL_VERSION,
  ILinkSessionExpiredError,
  type ILinkResponse,
  apiOk,
  buildIlinkHeaders,
  isSessionExpired,
  randomWechatUin,
  validateIlinkBaseUrl,
} from "./ilink-protocol";
import { type InboundMessage, parseInboundMessage } from "./messages";

const MAXIMUM_RESPONSE_CHARS = 1_048_576;
const QR_REQUEST_TIMEOUT_MS = 15_000;

export interface ILinkClientConfig {
  readonly baseUrl?: string;
  readonly timeoutMs: number;
  readonly fetchImpl?: typeof fetch;
}

export interface QrLoginRequest {
  readonly qrcodeId: string;
  readonly qrPayload: string;
}

export interface QrLoginStatus {
  readonly status: "wait" | "scanned" | "confirmed" | "expired";
  readonly botToken?: string;
  readonly ilinkBotId?: string;
  readonly baseUrl?: string;
}

export interface ILinkUpdates {
  readonly syncBuf: string;
  readonly messages: readonly InboundMessage[];
}

export class ILinkClient {
  baseUrl: string;
  token: string | null = null;
  accountId = "";

  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: ILinkClientConfig) {
    this.baseUrl = validateIlinkBaseUrl(config.baseUrl ?? ILINK_BASE_URL);
    this.timeoutMs = config.timeoutMs;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async requestQrCode(): Promise<QrLoginRequest> {
    const data = await this.request("GET", "ilink/bot/get_bot_qrcode", {
      params: { bot_type: ILINK_BOT_TYPE },
      timeoutMs: QR_REQUEST_TIMEOUT_MS,
    });
    const qrcodeId = String(data.qrcode ?? "").trim();
    const qrPayload = String(data.qrcode_img_content ?? "").trim();
    if (!qrcodeId || !qrPayload) {
      throw new Error(`QR response missing payload: ${summary(data)}`);
    }
    return { qrcodeId, qrPayload };
  }

  async pollQrStatus(qrcodeId: string): Promise<QrLoginStatus> {
    const data = await this.request("GET", "ilink/bot/get_qrcode_status", {
      extraHeaders: { [ILINK_APP_CLIENT_VERSION_HEADER]: "1" },
      params: { qrcode: qrcodeId },
      timeoutMs: this.timeoutMs,
    });
    const status = String(data.status ?? "wait").trim();
    if (status === "confirmed") {
      const botToken = String(data.bot_token ?? "").trim();
      if (!botToken) {
        throw new Error("QR login confirmed but no bot_token returned");
      }
      const rawBaseUrl = String(data.baseurl ?? "").trim();
      const baseUrl = rawBaseUrl ? validateIlinkBaseUrl(rawBaseUrl) : "";
      const confirmed: QrLoginStatus = {
        botToken,
        ilinkBotId: String(data.ilink_bot_id ?? "").trim(),
        status: "confirmed",
      };
      return baseUrl ? { ...confirmed, baseUrl } : confirmed;
    }
    if (status === "expired") return { status: "expired" };
    if (status === "scanned") return { status: "scanned" };
    return { status: "wait" };
  }

  async getUpdates(syncBuf: string): Promise<ILinkUpdates> {
    const data = await this.request("POST", "ilink/bot/getupdates", {
      payload: {
        base_info: { channel_version: ILINK_CHANNEL_VERSION },
        get_updates_buf: syncBuf,
      },
      timeoutMs: this.timeoutMs,
      tokenRequired: true,
    });
    if (isSessionExpired(data)) throw new ILinkSessionExpiredError();
    if (!apiOk(data)) {
      throw new Error(`getupdates failed: ${summary(data)}`);
    }
    const rawMessages = Array.isArray(data.msgs) ? data.msgs : [];
    const messages = rawMessages
      .map((raw) => parseInboundMessage(raw))
      .filter((message): message is InboundMessage => message !== null);
    return {
      messages,
      syncBuf: typeof data.get_updates_buf === "string"
        ? data.get_updates_buf
        : syncBuf,
    };
  }

  async sendMessage(input: {
    readonly clientId: string;
    readonly toUserId: string;
    readonly contextToken: string;
    readonly text: string;
  }): Promise<boolean> {
    const payload = {
      base_info: { channel_version: ILINK_CHANNEL_VERSION },
      msg: {
        client_id: input.clientId,
        context_token: input.contextToken,
        from_user_id: "",
        item_list: [{ text_item: { text: input.text }, type: 1 }],
        message_state: 2,
        message_type: 2,
        to_user_id: input.toUserId,
      },
    };
    const data = await this.request("POST", "ilink/bot/sendmessage", {
      payload,
      tokenRequired: true,
    });
    if (isSessionExpired(data)) throw new ILinkSessionExpiredError();
    return apiOk(data);
  }

  private async request(
    method: "GET" | "POST",
    endpoint: string,
    options: {
      readonly params?: Record<string, string>;
      readonly payload?: unknown;
      readonly tokenRequired?: boolean;
      readonly timeoutMs?: number;
      readonly extraHeaders?: Record<string, string>;
    } = {},
  ): Promise<ILinkResponse> {
    const url = new URL(`${this.baseUrl}/${endpoint.replace(/^\/+/u, "")}`);
    for (const [key, value] of Object.entries(options.params ?? {})) {
      url.searchParams.set(key, value);
    }
    const headers = buildIlinkHeaders({
      randomUin: randomWechatUin,
      token: options.tokenRequired ? this.token : null,
    });
    Object.assign(headers, options.extraHeaders ?? {});
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    // Long-poll deadlines are expected to expire; give a small grace window so
    // the client, not the transport, decides how to treat an empty return.
    const signal = AbortSignal.timeout(timeoutMs + 5_000);
    const init: RequestInit = { headers, method, redirect: "error", signal };
    if (options.payload !== undefined) {
      init.body = JSON.stringify(options.payload);
    }
    const response = await this.fetchImpl(url, init);
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `${method} ${endpoint} HTTP ${response.status}: ${text.slice(0, 200)}`,
      );
    }
    if (text.length > MAXIMUM_RESPONSE_CHARS) {
      throw new Error(`${method} ${endpoint} response too large`);
    }
    if (!text.trim()) return {};
    try {
      return JSON.parse(text) as ILinkResponse;
    } catch {
      throw new Error(
        `${method} ${endpoint} returned non-JSON: ${text.slice(0, 200)}`,
      );
    }
  }
}

function summary(payload: ILinkResponse): string {
  return `ret=${payload.ret ?? "?"} errcode=${payload.errcode ?? "?"} errmsg=${
    String(payload.errmsg ?? "").slice(0, 120)
  }`;
}
