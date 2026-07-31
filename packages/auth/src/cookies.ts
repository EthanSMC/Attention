import { assertOpaqueToken } from "./tokens";

export const secureSessionCookieName = "__Host-attention_session";
export const developmentSessionCookieName = "attention_session";

export interface SessionCookieOptions {
  secure?: boolean;
  now?: Date;
}

export function getSessionCookieName(secure = true): string {
  return secure ? secureSessionCookieName : developmentSessionCookieName;
}

export function serializeSessionCookie(
  token: string,
  expiresAt: Date,
  options: SessionCookieOptions = {}
): string {
  assertOpaqueToken(token);
  const secure = options.secure ?? true;
  const now = options.now ?? new Date();
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - now.getTime()) / 1_000));
  const attributes = [
    `${getSessionCookieName(secure)}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
    `Expires=${expiresAt.toUTCString()}`
  ];
  if (secure) {
    attributes.push("Secure");
  }
  return attributes.join("; ");
}

export function serializeExpiredSessionCookie(options: Pick<SessionCookieOptions, "secure"> = {}): string {
  const secure = options.secure ?? true;
  const attributes = [
    `${getSessionCookieName(secure)}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT"
  ];
  if (secure) {
    attributes.push("Secure");
  }
  return attributes.join("; ");
}

export function readSessionToken(cookieHeader: string | null | undefined, secure = true): string | null {
  if (!cookieHeader) {
    return null;
  }

  const name = getSessionCookieName(secure);
  for (const item of cookieHeader.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0) {
      continue;
    }
    if (item.slice(0, separator).trim() !== name) {
      continue;
    }
    const value = item.slice(separator + 1).trim();
    try {
      assertOpaqueToken(value);
      return value;
    } catch {
      return null;
    }
  }
  return null;
}
