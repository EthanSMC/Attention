/**
 * iLink wire protocol constants and pure helpers for the local
 * attention-channel bridge.
 *
 * Protocol reference: Tencent official iLink bot API
 * (`https://ilinkai.weixin.qq.com`), ported from the working Python PoC on
 * the orphan `wechat-adapter` branch (`ilink_bot.py`), whose protocol logic
 * was itself extracted from the AstrBot `weixin_oc` adapter. The bridge
 * keeps every iLink credential on the user's device.
 */

export const ILINK_BASE_URL = "https://ilinkai.weixin.qq.com";

/**
 * Prevents a persisted or QR-supplied base URL from redirecting the local
 * iLink bearer credential outside Tencent's official WeChat domain.
 */
export function validateIlinkBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("iLink base URL is not an official WeChat HTTPS endpoint");
  }
  const hostname = url.hostname.toLowerCase();
  const ownedByWeChat =
    hostname === "weixin.qq.com" || hostname.endsWith(".weixin.qq.com");
  if (
    url.protocol !== "https:" ||
    !ownedByWeChat ||
    (url.port !== "" && url.port !== "443") ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("iLink base URL is not an official WeChat HTTPS endpoint");
  }
  return url.toString().replace(/\/+$/u, "");
}

/** errcode returned when the bot login session has expired. */
export const ILINK_SESSION_TIMEOUT_ERRCODE = -14;

/** Identifies this minimal bridge implementation to the iLink service. */
export const ILINK_CHANNEL_VERSION = "ilink-mini-bot";

/** `bot_type` used for personal WeChat ClawBot login. */
export const ILINK_BOT_TYPE = "3";

/** Extra header required while polling QR login status. */
export const ILINK_APP_CLIENT_VERSION_HEADER = "iLink-App-ClientVersion";

export interface ILinkResponse {
  readonly ret?: number;
  readonly errcode?: number;
  readonly errmsg?: string;
  readonly [key: string]: unknown;
}

export class ILinkSessionExpiredError extends Error {
  constructor(message = "iLink session expired") {
    super(message);
    this.name = "ILinkSessionExpiredError";
  }
}

export function apiOk(payload: ILinkResponse): boolean {
  const ret = Number(payload.ret ?? 0) || 0;
  const errcode = Number(payload.errcode ?? 0) || 0;
  return ret === 0 && errcode === 0;
}

export function isSessionExpired(payload: ILinkResponse): boolean {
  return Number(payload.errcode ?? 0) === ILINK_SESSION_TIMEOUT_ERRCODE;
}

/**
 * Builds the headers every iLink request carries. The `X-WECHAT-UIN` header
 * is a fresh random value per request, matching the reference PoC.
 */
export function buildIlinkHeaders(options: {
  readonly token?: string | null;
  readonly randomUin: () => string;
}): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "AuthorizationType": "ilink_bot_token",
    "X-WECHAT-UIN": Buffer.from(options.randomUin(), "utf8").toString(
      "base64",
    ),
  };
  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }
  return headers;
}

/**
 * Derives the random decimal string used for `X-WECHAT-UIN`. Kept separate so
 * tests can pin it.
 */
export function randomWechatUin(
  randomInt: (max: number) => number = (max) =>
    Math.floor(Math.random() * max),
): string {
  return String(randomInt(2 ** 32));
}
