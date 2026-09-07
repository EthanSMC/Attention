import {randomUUID} from "node:crypto";
import {z} from "zod";
import type {AttentionDatabase} from "@attention/db";
import {mutationRequestError, noStoreJson} from "./api-guard";
import {getRequestPrincipal} from "./session";
import {getWebDatabase} from "./db";
import {readJsonRequestWithinLimit, RequestBodyTooLargeError, InvalidRequestBodyError} from "./request-body";
import {readCollectionSource, collectionSourceRequestSchema, CollectionSourceReadError, type SourceReadDependencies} from "./collection-source-reader";
import {CollectionStatusServiceError} from "./collection-status-service";
import {FetcherClientError} from "./fetcher-client";

interface SessionReaderPrincipal {accountId: string; sessionId: string; isMember: boolean; isFilter: boolean}
interface Dependencies {
  resolve(request: Request): Promise<SessionReaderPrincipal | null>;
  getDatabase(): AttentionDatabase;
  readerDependencies?: SourceReadDependencies;
}
export async function handleSourceReadRequest(request: Request, collectionId: string,
  deps: Dependencies = {resolve: getRequestPrincipal, getDatabase: getWebDatabase}): Promise<Response> {
  const guard = mutationRequestError(request);
  if (guard) return noStoreJson({error: {code: guard}}, {status: 400});
  const principal = await deps.resolve(request);
  if (!principal) return noStoreJson({error: {code: "authentication_required"}}, {status: 401});
  try {
    const body = collectionSourceRequestSchema.omit({collection_id: true}).parse(await readJsonRequestWithinLimit(request, 8192));
    const result = await readCollectionSource({accountId: principal.accountId, getDatabase: deps.getDatabase,
      runId: randomUUID(), signal: request.signal, revalidate: async () => {
        const current = await deps.resolve(request);
        return current?.accountId === principal.accountId && current.sessionId === principal.sessionId
          ? {...current, scopes: ["collection:read"]} : null;
      }}, {...body, collection_id: collectionId}, deps.readerDependencies);
    return noStoreJson(result);
  } catch (error) {
    if (error instanceof FetcherClientError) return noStoreJson({error: {code: error.code}},
      {status: error.code === "fetcher_timeout" ? 504 : error.code === "fetcher_unavailable" ? 503 : 502});
    if (error instanceof RequestBodyTooLargeError) return noStoreJson({error: {code: "request_too_large"}}, {status: 413});
    if (error instanceof z.ZodError || error instanceof InvalidRequestBodyError) return noStoreJson({error: {code: "invalid_request"}}, {status: 400});
    if (error instanceof CollectionSourceReadError || error instanceof CollectionStatusServiceError)
      return noStoreJson({error: {code: error.code}}, {status: error.httpStatus});
    return noStoreJson({error: {code: "internal_error"}}, {status: 500});
  }
}
