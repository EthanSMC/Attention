import "server-only";

import {
  getSessionCookieName,
  readSessionToken,
  resolveSession,
  serializeExpiredSessionCookie,
  serializeSessionCookie,
  type IssuedSession,
  type SessionPrincipal
} from "@attention/auth";
import type { NextResponse } from "next/server";
import { cookies } from "next/headers";

import { getWebDatabase } from "./db";

const secureCookie = process.env.NODE_ENV === "production";

export interface RequestSession {
  principal: SessionPrincipal | null;
  shouldClearCookie: boolean;
}

function hasNamedCookie(cookieHeader: string | null, name: string): boolean {
  if (!cookieHeader) {
    return false;
  }
  return cookieHeader.split(";").some((item) => {
    const separator = item.indexOf("=");
    return separator >= 0 && item.slice(0, separator).trim() === name;
  });
}

export async function getRequestSession(request: Request): Promise<RequestSession> {
  const cookieHeader = request.headers.get("cookie");
  const hasCookie = hasNamedCookie(cookieHeader, getSessionCookieName(secureCookie));
  if (!hasCookie) {
    return { principal: null, shouldClearCookie: false };
  }

  const token = readSessionToken(cookieHeader, secureCookie);
  if (!token) {
    return { principal: null, shouldClearCookie: true };
  }

  const principal = await resolveSession(getWebDatabase(), token);
  return {
    principal,
    shouldClearCookie: principal === null
  };
}

export async function getRequestPrincipal(request: Request): Promise<SessionPrincipal | null> {
  return (await getRequestSession(request)).principal;
}

export async function getPagePrincipal(): Promise<SessionPrincipal | null> {
  const token = (await cookies()).get(getSessionCookieName(secureCookie))?.value;
  if (!token) return null;
  return resolveSession(getWebDatabase(), token);
}

export function setSessionCookie(response: NextResponse, session: IssuedSession): void {
  response.headers.append(
    "Set-Cookie",
    serializeSessionCookie(session.token, session.expiresAt, { secure: secureCookie })
  );
}

export function clearSessionCookie(response: NextResponse): void {
  response.headers.append(
    "Set-Cookie",
    serializeExpiredSessionCookie({ secure: secureCookie })
  );
}

export function clearInvalidSessionCookie(
  response: NextResponse,
  requestSession: RequestSession
): void {
  if (requestSession.shouldClearCookie) {
    clearSessionCookie(response);
  }
}
