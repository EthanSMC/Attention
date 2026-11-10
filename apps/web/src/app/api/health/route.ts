import release from "../../../../../../release.json";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(): Response {
  return Response.json(
    { status: "ok", version: release.version },
    { headers: { "Cache-Control": "no-store" } },
  );
}
