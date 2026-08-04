import { randomBytes, timingSafeEqual } from "node:crypto";

import {
  inspectInvitation,
  InvitationError,
  redeemInvitation,
} from "@attention/auth";
import { type NextRequest, NextResponse } from "next/server";

import { mutationRequestError } from "../../../server/api-guard";
import { getWebDatabase } from "../../../server/db";
import { readUrlEncodedRequestWithinLimit } from "../../../server/request-body";
import {
  clearInvalidSessionCookie,
  getRequestSession,
  setSessionCookie,
} from "../../../server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface InviteRouteContext {
  params: Promise<{ token: string }>;
}

const secureCookie = process.env.NODE_ENV === "production";
const confirmationCookieName = secureCookie
  ? "__Host-attention_invite_confirmation"
  : "attention_invite_confirmation";

function newConfirmationToken(): string {
  return randomBytes(24).toString("base64url");
}

function confirmationMatches(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

function setConfirmationCookie(response: NextResponse, token: string): void {
  response.cookies.set({
    httpOnly: true,
    maxAge: 10 * 60,
    name: confirmationCookieName,
    path: "/",
    sameSite: "strict",
    secure: secureCookie,
    value: token,
  });
}

function clearConfirmationCookie(response: NextResponse): void {
  response.cookies.set({
    httpOnly: true,
    maxAge: 0,
    name: confirmationCookieName,
    path: "/",
    sameSite: "strict",
    secure: secureCookie,
    value: "",
  });
}

function redirect(request: NextRequest, pathname: string): NextResponse {
  const configuredOrigin = process.env.NEXT_PUBLIC_APP_URL?.trim();
  const baseUrl = configuredOrigin ? new URL(configuredOrigin) : new URL(request.url);
  const response = NextResponse.redirect(new URL(pathname, baseUrl), 303);
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}

function invitePage(
  title: string,
  description: string,
  options: { confirmationToken?: string; status?: number } = {},
): NextResponse {
  const action = options.confirmationToken
    ? `<form method="post"><input name="confirmation_token" type="hidden" value="${options.confirmationToken}"><button type="submit">确认身份并登录</button></form>`
    : '<a href="/">返回 Attention</a>';
  const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title} · Attention</title>
    <style>
      :root { color-scheme: light; font-family: ui-sans-serif, system-ui, sans-serif; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f5f3ed; color: #171716; }
      main { width: min(480px, calc(100% - 40px)); padding: 32px; border: 1px solid #d8d4c9; border-radius: 18px; background: #fffdf8; box-shadow: 0 18px 50px rgb(42 37 25 / 8%); }
      p { color: #656158; line-height: 1.7; }
      button, a { display: inline-flex; min-height: 46px; align-items: center; justify-content: center; margin-top: 12px; padding: 0 18px; border: 0; border-radius: 10px; background: #171716; color: white; font: inherit; font-weight: 700; text-decoration: none; cursor: pointer; }
    </style>
  </head>
  <body><main><h1>${title}</h1><p>${description}</p>${action}</main></body>
</html>`;
  const response = new NextResponse(html, {
    status: options.status ?? 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
  response.headers.set("Cache-Control", "no-store, max-age=0");
  response.headers.set(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  );
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  return response;
}

async function invitationErrorResponse(
  request: NextRequest,
  error: InvitationError,
): Promise<NextResponse> {
  const requestSession = await getRequestSession(request);
  if (error.code === "invitation_already_consumed" && requestSession.principal) {
    return redirect(request, "/collect");
  }

  const response = invitePage(
    "这个邀请已不可用",
    "链接可能已被使用或超过有效期。请联系邀请人获取新的链接。",
    { status: 410 },
  );
  clearInvalidSessionCookie(response, requestSession);
  return response;
}

export async function GET(
  request: NextRequest,
  context: InviteRouteContext,
): Promise<NextResponse> {
  const { token } = await context.params;
  try {
    const invitation = await inspectInvitation(getWebDatabase(), token);
    const confirmationToken = newConfirmationToken();
    const response = invitePage(
      "首次登录 Attention",
      invitation.kind === "filter"
        ? `你的稳定网名是 @${invitation.stableHandle}。确认后将以 Filter 身份登录，这台设备会保持登录 30 天。`
        : `你的稳定网名是 @${invitation.stableHandle}。确认后将登录 Attention，这台设备会保持登录 30 天。`,
      { confirmationToken },
    );
    setConfirmationCookie(response, confirmationToken);
    return response;
  } catch (error) {
    if (!(error instanceof InvitationError)) throw error;
    return invitationErrorResponse(request, error);
  }
}

export async function HEAD(
  request: NextRequest,
  context: InviteRouteContext,
): Promise<NextResponse> {
  const response = await GET(request, context);
  return new NextResponse(null, {
    status: response.status,
    headers: response.headers,
  });
}

export async function POST(
  request: NextRequest,
  context: InviteRouteContext,
): Promise<NextResponse> {
  const requestError = mutationRequestError(request);
  let submittedToken = "";
  try {
    const formData = await readUrlEncodedRequestWithinLimit(request, 8_192);
    const value = formData.get("confirmation_token");
    submittedToken = typeof value === "string" ? value : "";
  } catch {
    // Invalid form bodies are handled by the same generic 403 response.
  }
  const cookieToken = request.cookies.get(confirmationCookieName)?.value;
  const validConfirmation = confirmationMatches(cookieToken, submittedToken);
  if (requestError === "request_too_large" || !validConfirmation) {
    return invitePage("无法接受邀请", "请求来源不受信任，请从当前页面重试。", {
      status: 403,
    });
  }

  const { token } = await context.params;
  try {
    const redeemed = await redeemInvitation(getWebDatabase(), token);
    const response = redirect(request, "/collect");
    clearConfirmationCookie(response);
    setSessionCookie(response, redeemed.session);
    return response;
  } catch (error) {
    if (!(error instanceof InvitationError)) throw error;
    return invitationErrorResponse(request, error);
  }
}
