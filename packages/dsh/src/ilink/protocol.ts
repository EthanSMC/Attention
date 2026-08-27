/**
 * iLink protocol definitions for WeChat channel integration.
 *
 * The iLink protocol provides:
 * - QR code login to WeChat
 * - Long-polling for incoming messages
 * - Sending reply messages
 *
 * Reuses the same protocol as Attention CLI's Bridge.
 */

export const ILINK_BASE_URL = "https://ilink.weixin.qq.com" as const;

export interface ILinkQrSession {
  readonly sessionId: string;
  readonly qrCodeUrl: string;
  readonly expiresAt: number;
}

export interface ILinkToken {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number;
}

export interface ILinkInboundMessage {
  readonly messageId: string;
  readonly fromUser: string;
  readonly toUser: string;
  readonly content: string;
  readonly contentType: "text" | "link" | "image";
  readonly timestamp: number;
}

export interface ILinkOutboundMessage {
  readonly replyTo: string;
  readonly content: string;
}

export interface ILinkClientOptions {
  readonly baseUrl?: string;
  readonly pollTimeoutMs?: number;
  readonly maxQrRefreshes?: number;
}

export const DEFAULT_POLL_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_QR_REFRESHES = 3;
