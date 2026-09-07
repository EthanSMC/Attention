import {handleSourceReadRequest} from "../../../../../server/collection-source-read-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: {params: Promise<{collectionId: string}>}): Promise<Response> {
  return handleSourceReadRequest(request, (await context.params).collectionId);
}
