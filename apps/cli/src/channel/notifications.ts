import {
  ChannelSummaryNotificationPollResponseSchema,
  type ChannelSummaryNotificationPollResponse,
} from "@attention/contracts";

import { enqueueOutbound } from "./queue";
import {
  RUNTIME_REPORTER_SCOPES,
  type RuntimeAccessTokenProvider,
} from "./runtime-reporter";
import type { ChannelState } from "./state";

const NOTIFICATION_BATCH_SIZE = 20;
const NOTIFICATION_REQUEST_TIMEOUT_MS = 15_000;

export interface SummaryNotificationPollOptions {
  readonly accessTokenProvider: RuntimeAccessTokenProvider;
  readonly bindingId: string;
  readonly cursor?: string | null;
  readonly fetchImpl?: typeof fetch;
  readonly installationId: string;
  readonly runtimeBaseUrl: string;
}

export async function pollSummaryNotifications(
  options: SummaryNotificationPollOptions,
): Promise<ChannelSummaryNotificationPollResponse | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.runtimeBaseUrl.endsWith("/")
    ? options.runtimeBaseUrl
    : `${options.runtimeBaseUrl}/`;
  const url = new URL("notifications", baseUrl);
  url.searchParams.set("binding_id", options.bindingId);
  url.searchParams.set("installation_id", options.installationId);
  url.searchParams.set("limit", String(NOTIFICATION_BATCH_SIZE));
  if (options.cursor) url.searchParams.set("after", options.cursor);

  for (const forceRefresh of [false, true]) {
    let token: string | null;
    try {
      token = await options.accessTokenProvider.accessToken({
        forceRefresh,
        resource: options.runtimeBaseUrl,
        scopes: RUNTIME_REPORTER_SCOPES,
      });
    } catch {
      return null;
    }
    if (!token) return null;

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      NOTIFICATION_REQUEST_TIMEOUT_MS,
    );
    timeout.unref?.();
    try {
      const response = await fetchImpl(url, {
        headers: { authorization: `Bearer ${token}` },
        method: "GET",
        signal: controller.signal,
      });
      if (response.status === 401 && !forceRefresh) continue;
      if (!response.ok) return null;
      return ChannelSummaryNotificationPollResponseSchema.parse(
        await response.json(),
      );
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }
  return null;
}

export function enqueueSummaryNotifications(
  state: ChannelState,
  response: ChannelSummaryNotificationPollResponse,
): boolean {
  const toUserId = state.ownerUserId;
  const contextToken = toUserId
    ? state.contextTokens[toUserId] ?? ""
    : "";
  if (!toUserId || !contextToken) return false;

  const previousOutboundCount = state.pendingOutbound.length;
  for (const item of response.items) {
    enqueueOutbound(state, {
      contextToken,
      id: `summary-ready-${item.notification_id}`,
      text:
        `你收藏的《${item.title}》摘要已完成：\n\n${item.summary}` +
        `\n\n查看原文：${item.original_url}`,
      toUserId,
    });
  }
  const cursorChanged =
    response.next_cursor !== state.summaryNotificationCursor;
  if (cursorChanged) state.summaryNotificationCursor = response.next_cursor;
  return cursorChanged || state.pendingOutbound.length !== previousOutboundCount;
}
