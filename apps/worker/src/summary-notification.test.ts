import { describe, expect, it } from "vitest";

import { CHANNEL_SUMMARY_READY_EVENT_TYPE } from "@attention/contracts";

import { buildSummaryReadyNotificationEvent } from "./summary-notification";

describe("summary notification events", () => {
  it("builds a private idempotent event without copying content into the ledger", () => {
    expect(
      buildSummaryReadyNotificationEvent({
        contentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        occurredAt: new Date("2026-08-14T08:30:00.000Z"),
        requestId: "summary-job-1",
      }),
    ).toEqual({
      accountId: null,
      anonymousSessionId: null,
      contentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      dedupeKey:
        "content.summary.ready.v1:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      eventType: CHANNEL_SUMMARY_READY_EVENT_TYPE,
      metadata: { schema_version: 1 },
      occurredAt: new Date("2026-08-14T08:30:00.000Z"),
      requestId: "summary-job-1",
      scope: "private",
    });
  });
});
