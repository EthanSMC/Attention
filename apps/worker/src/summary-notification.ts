import {
  CHANNEL_SUMMARY_READY_EVENT_TYPE,
  summaryReadyNotificationDedupeKey,
} from "@attention/contracts";

export interface SummaryReadyNotificationEventInput {
  contentId: string;
  occurredAt: Date;
  requestId: string;
}

export function buildSummaryReadyNotificationEvent(
  input: SummaryReadyNotificationEventInput,
) {
  return {
    accountId: null,
    anonymousSessionId: null,
    contentId: input.contentId,
    dedupeKey: summaryReadyNotificationDedupeKey(input.contentId),
    eventType: CHANNEL_SUMMARY_READY_EVENT_TYPE,
    metadata: { schema_version: 1 },
    occurredAt: input.occurredAt,
    requestId: input.requestId,
    scope: "private" as const,
  };
}
