import { truncateUtf8 } from "./text.js";

export class WechatApiError extends Error {
  constructor(
    readonly code: "invalid_wechat_response" | "wechat_api_rejected" | "wechat_api_unavailable",
    readonly retryable: boolean,
  ) {
    super(code);
    this.name = "WechatApiError";
  }
}

interface CachedToken {
  expiresAt: number;
  token: string;
}

async function safeJson(response: Response): Promise<Record<string, unknown>> {
  const raw = await response.text();
  if (raw.length > 1_000_000) throw new WechatApiError("invalid_wechat_response", true);
  let value: unknown;
  try { value = JSON.parse(raw); } catch {
    throw new WechatApiError("invalid_wechat_response", true);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WechatApiError("invalid_wechat_response", true);
  }
  return value as Record<string, unknown>;
}

export class WechatAccessTokenProvider {
  private cached: CachedToken | null = null;
  private inFlight: Promise<string> | null = null;

  constructor(
    private readonly config: { apiBaseUrl: string; appId: string; appSecret: string },
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async getToken(): Promise<string> {
    if (this.cached && this.cached.expiresAt > this.now()) return this.cached.token;
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.fetchToken().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  invalidate(): void {
    this.cached = null;
  }

  private async fetchToken(): Promise<string> {
    const url = new URL("/cgi-bin/token", `${this.config.apiBaseUrl}/`);
    url.searchParams.set("grant_type", "client_credential");
    url.searchParams.set("appid", this.config.appId);
    url.searchParams.set("secret", this.config.appSecret);
    let response: Response;
    try {
      response = await this.fetchImplementation(url, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new WechatApiError("wechat_api_unavailable", true);
    }
    const payload = await safeJson(response);
    if (!response.ok || typeof payload.errcode === "number" && payload.errcode !== 0) {
      throw new WechatApiError("wechat_api_rejected", response.status >= 500 ||
        payload.errcode === -1 || payload.errcode === 45009);
    }
    const token = payload.access_token;
    const expiresIn = payload.expires_in;
    if (typeof token !== "string" || token.length < 16 || token.length > 2_048 ||
      typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn < 300) {
      throw new WechatApiError("invalid_wechat_response", true);
    }
    this.cached = {
      expiresAt: this.now() + Math.max(60, expiresIn - 300) * 1_000,
      token,
    };
    return token;
  }
}

export class WechatCustomerServiceSender {
  constructor(
    private readonly apiBaseUrl: string,
    private readonly tokens: WechatAccessTokenProvider,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  async sendText(openId: string, text: string): Promise<void> {
    if (!openId || openId.length > 128 || !text.trim()) {
      throw new WechatApiError("invalid_wechat_response", false);
    }
    await this.sendWithToken(openId, text, true);
  }

  private async sendWithToken(openId: string, text: string, allowTokenRetry: boolean): Promise<void> {
    const token = await this.tokens.getToken();
    const url = new URL("/cgi-bin/message/custom/send", `${this.apiBaseUrl}/`);
    url.searchParams.set("access_token", token);
    let response: Response;
    try {
      response = await this.fetchImplementation(url, {
        body: JSON.stringify({
          msgtype: "text",
          text: { content: truncateUtf8(text, 2_000) },
          touser: openId,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new WechatApiError("wechat_api_unavailable", true);
    }
    const payload = await safeJson(response);
    if (!response.ok || payload.errcode !== 0) {
      if (payload.errcode === 40014 || payload.errcode === 42001) {
        this.tokens.invalidate();
        if (allowTokenRetry) return this.sendWithToken(openId, text, false);
      }
      throw new WechatApiError("wechat_api_rejected", response.status >= 500 ||
        payload.errcode === -1 || payload.errcode === 45009);
    }
  }
}
