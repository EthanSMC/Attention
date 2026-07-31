import { NextResponse } from "next/server";

function protect(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("X-Content-Type-Options", "nosniff");
  return response;
}

export function outboundRedirect(url: URL): NextResponse {
  return protect(NextResponse.redirect(url, 302));
}

export function outboundUnavailable(
  message = "该原文当前不可访问。",
  status = 404,
): NextResponse {
  return protect(
    new NextResponse(message, {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      status,
    }),
  );
}
