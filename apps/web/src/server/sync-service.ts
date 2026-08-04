import {
  and,
  asc,
  collectionEvents,
  collections,
  CollectionRepositoryError,
  contents,
  eq,
  gt,
  or,
  publicContentsCurrent,
  setCollectionVisibility,
  deleteCollection,
  sql,
  type AttentionDatabase,
} from "@attention/db";
import { resolveAccountCapabilities } from "@attention/auth";

import { collectFromWeb, CollectionServiceError } from "./collection-service";
import type { CloudPrincipal } from "./cloud-credentials";

interface SyncCursor {
  eventId: string;
  occurredAt: string;
}

export type SyncMutation =
  | {
      clientMutationId: string;
      historical: boolean;
      op: "collect";
      rawInput: string;
      visibility: "private" | "public";
    }
  | { clientMutationId: string; collectionId: string; op: "delete" }
  | {
      clientMutationId: string;
      collectionId: string;
      op: "visibility";
      visibility: "private" | "public";
    };

function encodeCursor(value: SyncCursor): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor(value: string | null): SyncCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<SyncCursor>;
    if (
      typeof parsed.eventId !== "string" || !/^[0-9a-f-]{36}$/iu.test(parsed.eventId) ||
      typeof parsed.occurredAt !== "string" || Number.isNaN(Date.parse(parsed.occurredAt))
    ) return null;
    return { eventId: parsed.eventId, occurredAt: parsed.occurredAt };
  } catch { return null; }
}

export async function pullSyncEvents(
  db: AttentionDatabase,
  accountId: string,
  input: { cursor: string | null; limit: number },
) {
  const cursor = decodeCursor(input.cursor);
  if (input.cursor && !cursor) throw new RangeError("invalid_cursor");
  const [capabilities, rows] = await Promise.all([
    resolveAccountCapabilities(db, accountId),
    db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.account_id', ${accountId}, true)`);
      return tx
        .select({
          collectionId: collectionEvents.collectionId,
          contentId: collectionEvents.contentId,
          eventId: collectionEvents.id,
          eventType: collectionEvents.eventType,
          nextState: collectionEvents.nextState,
          occurredAt: collectionEvents.occurredAt,
          outboundUrl: contents.outboundUrl,
          publicContentId: publicContentsCurrent.id,
          source: contents.source,
          summary: contents.aiSummary,
          summaryStatus: contents.summaryStatus,
          tags: contents.aiTags,
          title: contents.title,
        })
        .from(collectionEvents)
        .innerJoin(contents, eq(contents.id, collectionEvents.contentId))
        .innerJoin(collections, eq(collections.id, collectionEvents.collectionId))
        .leftJoin(publicContentsCurrent, eq(publicContentsCurrent.id, contents.id))
        .where(
          and(
            eq(collectionEvents.accountId, accountId),
            cursor
              ? or(
                  gt(collectionEvents.occurredAt, new Date(cursor.occurredAt)),
                  and(
                    eq(collectionEvents.occurredAt, new Date(cursor.occurredAt)),
                    gt(collectionEvents.id, cursor.eventId),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(asc(collectionEvents.occurredAt), asc(collectionEvents.id))
        .limit(input.limit + 1);
    }),
  ]);
  const hasMore = rows.length > input.limit;
  const selected = rows.slice(0, input.limit);
  const last = selected.at(-1);
  return {
    events: selected.map((row) => {
      const derivedVisible = capabilities.isMember || row.publicContentId !== null;
      return {
        collection_id: row.collectionId,
        content: {
          content_id: row.contentId,
          original_url: row.outboundUrl,
          source: row.source,
          summary: derivedVisible ? row.summary : null,
          summary_status: derivedVisible ? row.summaryStatus : "unavailable",
          tags: derivedVisible ? row.tags : [],
          title: row.title,
        },
        event_id: row.eventId,
        event_type: row.eventType,
        next_state: row.nextState,
        occurred_at: row.occurredAt.toISOString(),
      };
    }),
    has_more: hasMore,
    next_cursor: last
      ? encodeCursor({ eventId: last.eventId, occurredAt: last.occurredAt.toISOString() })
      : input.cursor,
  };
}

export async function pushSyncMutations(
  db: AttentionDatabase,
  principal: CloudPrincipal,
  mutations: SyncMutation[],
) {
  const results: Array<Record<string, unknown>> = [];
  for (const mutation of mutations) {
    try {
      if (mutation.op === "collect") {
        const visibility = mutation.historical ? "private" : mutation.visibility;
        const result = await collectFromWeb(db, principal, {
          idempotency_key: mutation.clientMutationId,
          raw_input: mutation.rawInput,
          visibility,
        });
        results.push({ client_mutation_id: mutation.clientMutationId, result, status: "applied" });
      } else if (mutation.op === "delete") {
        const collection = await deleteCollection(db, {
          accountId: principal.accountId,
          collectionId: mutation.collectionId,
        });
        results.push({ client_mutation_id: mutation.clientMutationId, collection_id: collection.id, status: "applied" });
      } else {
        const collection = await setCollectionVisibility(db, {
          accountId: principal.accountId,
          collectionId: mutation.collectionId,
          visibility: mutation.visibility,
        });
        results.push({ client_mutation_id: mutation.clientMutationId, collection_id: collection.id, status: "applied", visibility: collection.visibility });
      }
    } catch (error) {
      const errorCode = error instanceof CollectionServiceError || error instanceof CollectionRepositoryError
        ? error.code
        : "mutation_failed";
      results.push({
        client_mutation_id: mutation.clientMutationId,
        error: errorCode,
        status: "rejected",
      });
    }
  }
  return { results };
}
