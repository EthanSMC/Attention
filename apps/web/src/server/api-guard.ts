import "server-only";

import { NextResponse } from "next/server";

const DEFAULT_MAX_CONTENT_LENGTH_BYTES = 40_960;

export function mutationRequestError(
  request: Request,
  options: { maxContentLengthBytes?: number } = {},
): string | null {
  const maxContentLengthBytes =
    options.maxContentLengthBytes ?? DEFAULT_MAX_CONTENT_LENGTH_BYTES;
  if (
    !Number.isSafeInteger(maxContentLengthBytes) ||
    maxContentLengthBytes < 0
  ) {
    throw new RangeError("invalid_max_content_length");
  }
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (
    Number.isFinite(contentLength) &&
    contentLength > maxContentLengthBytes
  ) {
    return "request_too_large";
  }

  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    return "cross_origin_request";
  }

  const origin = request.headers.get("origin");
  if (origin) {
    const requestOrigin = new URL(request.url).origin;
    const configuredOrigin = process.env.NEXT_PUBLIC_APP_URL
      ? new URL(process.env.NEXT_PUBLIC_APP_URL).origin
      : requestOrigin;
    if (origin !== requestOrigin && origin !== configuredOrigin) {
      return "cross_origin_request";
    }
  }
  return null;
}

export function noStoreJson(
  body: unknown,
  init: { status?: number } = {},
): NextResponse {
  const response = NextResponse.json(body, init);
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("X-Content-Type-Options", "nosniff");
  return response;
}
