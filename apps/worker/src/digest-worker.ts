import { resolveAccountCapabilities } from "@attention/auth";
import type { DatabaseHandle } from "@attention/db";

import type { WorkerConfig } from "./config.js";
import {
  claimNextDigestDelivery,
  completeDigestDelivery,
  createDigestDelivery,
  failDigestDelivery,
  listDigestScheduleCandidates,
  loadCurrentDeliveryContext,
  markDigestDeliverySkipped,
  reapExhaustedDigestDeliveries,
  revalidateDigestItems,
  type ClaimedDigestDelivery,
} from "./digest-repository.js";
import {
  digestContentWindow,
  isInsideSendWindow,
  localDateString,
} from "./digest-time.js";
import { renderDigestEmail } from "./digest-template.js";
import { EmailProviderError, type EmailProvider } from "./email-provider.js";
import type { WorkerLogger } from "./logger.js";

function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(done, milliseconds);
    function done() {
      clearTimeout(timeout);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export async function scheduleDueDigests(input: {
  config: WorkerConfig;
  handle: DatabaseHandle;
  logger: WorkerLogger;
  now: Date;
}): Promise<number> {
  const candidates = await listDigestScheduleCandidates(input.handle.sql);
  let created = 0;
  for (const candidate of candidates) {
    try {
      if (
        !isInsideSendWindow(
          input.now,
          candidate.timezone,
          candidate.sendWindowStartMinute,
          candidate.sendWindowMinutes,
        )
      ) {
        continue;
      }
      const capabilities = await resolveAccountCapabilities(
        input.handle.db,
        candidate.accountId,
        input.now,
      );
      if (!capabilities.isMember && !capabilities.isFilter) continue;
      const localDate = localDateString(input.now, candidate.timezone);
      const window = digestContentWindow(localDate, candidate.timezone);
      const delivery = await createDigestDelivery(input.handle.sql, {
        accountId: candidate.accountId,
        availableAt: input.now,
        domainId: candidate.domainId,
        email: candidate.email,
        localDate,
        maxAttempts: input.config.digestMaxAttempts,
        scheduledFor: input.now,
        timezone: candidate.timezone,
        windowEnd: window.end,
        windowStart: window.start,
      });
      if (delivery) {
        created += 1;
        input.logger.info("digest_delivery_scheduled", {
          deliveryId: delivery.deliveryId,
          itemCount: delivery.itemCount,
        });
      }
    } catch {
      input.logger.error("digest_schedule_candidate_failed", {
        accountId: candidate.accountId,
        domainId: candidate.domainId,
      });
    }
  }
  return created;
}

async function skipDelivery(
  handle: DatabaseHandle,
  delivery: ClaimedDigestDelivery,
  reason: string,
  logger: WorkerLogger,
  now: Date,
) {
  const updated = await markDigestDeliverySkipped(handle.sql, {
    claimToken: delivery.lockedBy,
    deliveryId: delivery.id,
    now,
    reason,
  });
  logger[updated ? "info" : "warn"]("digest_delivery_skipped", {
    deliveryId: delivery.id,
    reason,
    updated,
  });
}

export async function processDigestDelivery(input: {
  config: WorkerConfig;
  delivery: ClaimedDigestDelivery;
  handle: DatabaseHandle;
  logger: WorkerLogger;
  now: Date;
  provider: EmailProvider;
}): Promise<void> {
  try {
    const [context, capabilities] = await Promise.all([
      loadCurrentDeliveryContext(input.handle.sql, input.delivery.id),
      resolveAccountCapabilities(
        input.handle.db,
        input.delivery.accountId,
        input.now,
      ),
    ]);
    if (!context) {
      await skipDelivery(
        input.handle,
        input.delivery,
        "subscription_inactive",
        input.logger,
        input.now,
      );
      return;
    }
    if (!capabilities.isMember && !capabilities.isFilter) {
      await skipDelivery(
        input.handle,
        input.delivery,
        "entitlement_inactive",
        input.logger,
        input.now,
      );
      return;
    }

    const items = await revalidateDigestItems(input.handle.sql, input.delivery.id);
    if (items.length === 0) {
      await skipDelivery(
        input.handle,
        input.delivery,
        "no_current_public_content",
        input.logger,
        input.now,
      );
      return;
    }

    const email = renderDigestEmail({
      domainName: context.domainName,
      items: items.map((item) => ({
        author: item.author,
        originalUrl: `${input.config.publicOrigin}/out/public/${item.publicId}`,
        source: item.source,
        summary: item.summary,
        summaryStatus: item.summaryStatus,
        title: item.title,
      })),
      localDate: input.delivery.localDate,
      settingsUrl: `${input.config.publicOrigin}/account/digests`,
    });
    const result = await input.provider.send({
      ...email,
      idempotencyKey: input.delivery.id,
      to: context.email,
    });
    const updated = await completeDigestDelivery(input.handle.sql, {
      claimToken: input.delivery.lockedBy,
      deliveryId: input.delivery.id,
      email: context.email,
      now: new Date(),
      providerMessageId: result.providerMessageId,
    });
    input.logger[updated ? "info" : "warn"]("digest_delivery_sent", {
      deliveryId: input.delivery.id,
      itemCount: items.length,
      updated,
    });
  } catch (error) {
    const errorCode =
      error instanceof EmailProviderError
        ? error.code
        : "digest_delivery_internal_error";
    try {
      const result = await failDigestDelivery(input.handle.sql, {
        baseRetryMs: input.config.baseRetryMs,
        delivery: input.delivery,
        errorCode,
        maxRetryMs: input.config.maxRetryMs,
        now: new Date(),
      });
      input.logger[result === "failed" ? "error" : "warn"](
        "digest_delivery_failed",
        {
          attempt: input.delivery.attempts,
          deliveryId: input.delivery.id,
          errorCode,
          result,
        },
      );
    } catch {
      input.logger.error("digest_delivery_failure_record_failed", {
        deliveryId: input.delivery.id,
        errorCode,
      });
    }
  }
}

export async function runDigestCycle(input: {
  config: WorkerConfig;
  handle: DatabaseHandle;
  logger: WorkerLogger;
  now?: Date;
  provider: EmailProvider;
}): Promise<{ processed: number; scheduled: number }> {
  const now = input.now ?? new Date();
  const reaped = await reapExhaustedDigestDeliveries(input.handle.sql, {
    leaseMs: input.config.leaseMs,
    now,
  });
  if (reaped > 0) {
    input.logger.warn("exhausted_digest_deliveries_reaped", { count: reaped });
  }
  const scheduled = await scheduleDueDigests({ ...input, now });
  let processed = 0;
  while (processed < input.config.digestBatchSize) {
    const delivery = await claimNextDigestDelivery(input.handle.sql, {
      leaseMs: input.config.leaseMs,
      now: new Date(),
      workerId: `${input.config.workerId.slice(0, 52)}:digest`,
    });
    if (!delivery) break;
    processed += 1;
    await processDigestDelivery({ ...input, delivery, now: new Date() });
  }
  return { processed, scheduled };
}

export async function runDigestWorker(input: {
  config: WorkerConfig;
  handle: DatabaseHandle;
  logger: WorkerLogger;
  provider: EmailProvider;
  signal: AbortSignal;
}): Promise<void> {
  input.logger.info("digest_worker_started", {
    pollIntervalMs: input.config.digestPollIntervalMs,
  });
  while (!input.signal.aborted) {
    try {
      await runDigestCycle(input);
    } catch {
      input.logger.error("digest_cycle_failed");
    }
    await abortableSleep(input.config.digestPollIntervalMs, input.signal);
  }
  input.logger.info("digest_worker_stopped");
}
