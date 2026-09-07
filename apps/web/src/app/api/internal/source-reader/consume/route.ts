import {handleReaderAdmission} from "../../../../../server/source-read-coordinator";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request): Promise<Response> {return handleReaderAdmission(request, "consume");}
