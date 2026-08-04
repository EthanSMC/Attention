import type { DatabaseHandle } from "@attention/db";

type DigestSql = DatabaseHandle["sql"];

interface ScheduleCandidateRow {
  account_id: string;
  domain_id: string;
  domain_name: string;
  primary_email: string;
  send_window_minutes: number;
  send_window_start_minute: number;
  timezone: string;
}

export interface DigestScheduleCandidate {
  accountId: string;
  domainId: string;
  domainName: string;
  email: string;
  sendWindowMinutes: number;
  sendWindowStartMinute: number;
  timezone: string;
}

export async function listDigestScheduleCandidates(
  sql: DigestSql,
): Promise<DigestScheduleCandidate[]> {
  const rows = await sql<ScheduleCandidateRow[]>`
    SELECT preference.account_id,
           preference.timezone,
           preference.send_window_start_minute,
           preference.send_window_minutes,
           subscription.domain_id,
           domain.name AS domain_name,
           account.primary_email
    FROM account_digest_preferences AS preference
    JOIN domain_digest_subscriptions AS subscription
      ON subscription.account_id = preference.account_id
     AND subscription.active = true
    JOIN domains AS domain
      ON domain.id = subscription.domain_id
     AND domain.active = true
    JOIN accounts AS account
      ON account.id = preference.account_id
     AND account.status = 'active'
     AND account.primary_email IS NOT NULL
     AND account.email_verified_at IS NOT NULL
    WHERE preference.enabled = true
    ORDER BY preference.account_id, subscription.domain_id
  `;
  return rows.map((row) => ({
    accountId: row.account_id,
    domainId: row.domain_id,
    domainName: row.domain_name,
    email: row.primary_email,
    sendWindowMinutes: row.send_window_minutes,
    sendWindowStartMinute: row.send_window_start_minute,
    timezone: row.timezone,
  }));
}

export async function createDigestDelivery(
  sql: DigestSql,
  input: {
    accountId: string;
    availableAt: Date;
    domainId: string;
    email: string;
    localDate: string;
    maxAttempts: number;
    scheduledFor: Date;
    timezone: string;
    windowEnd: Date;
    windowStart: Date;
  },
): Promise<{ deliveryId: string; itemCount: number } | null> {
  const rows = await sql<{ delivery_id: string; item_count: number }[]>`
    WITH delivery AS (
      INSERT INTO digest_email_deliveries (
        account_id,
        domain_id,
        local_date,
        timezone,
        window_start,
        window_end,
        scheduled_for,
        recipient_email,
        max_attempts,
        available_at
      ) VALUES (
        ${input.accountId},
        ${input.domainId},
        ${input.localDate},
        ${input.timezone},
        ${input.windowStart.toISOString()},
        ${input.windowEnd.toISOString()},
        ${input.scheduledFor.toISOString()},
        ${input.email},
        ${input.maxAttempts},
        ${input.availableAt.toISOString()}
      )
      ON CONFLICT (account_id, domain_id, local_date) DO NOTHING
      RETURNING id
    ), candidates AS (
      SELECT public_content.id AS content_id,
             public_content.visibility_version,
             (row_number() OVER (
               ORDER BY public_content.first_public_at ASC, public_content.id ASC
             ) - 1)::smallint AS ordinal
      FROM public_contents_current AS public_content
      WHERE public_content.first_public_at >= ${input.windowStart.toISOString()}
        AND public_content.first_public_at < ${input.windowEnd.toISOString()}
        AND public_content.summary_status <> 'hidden'
        AND EXISTS (
          SELECT 1
          FROM collections AS collection
          JOIN filter_profiles AS filter
            ON filter.account_id = collection.account_id
           AND filter.active = true
           AND filter.revoked_at IS NULL
          JOIN accounts AS filter_account
            ON filter_account.id = collection.account_id
           AND filter_account.status = 'active'
          JOIN domains AS domain
            ON domain.id = collection.domain_id
           AND domain.active = true
          WHERE collection.content_id = public_content.id
            AND collection.domain_id = ${input.domainId}
            AND collection.collection_status = 'active'
            AND collection.visibility = 'public'
            AND collection.public_since IS NOT NULL
            AND collection.filter_revoked_at IS NULL
            AND collection.moderation_status = 'clear'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM digest_email_delivery_items AS prior_item
          WHERE prior_item.account_id = ${input.accountId}
            AND prior_item.content_id = public_content.id
        )
    ), inserted_items AS (
      INSERT INTO digest_email_delivery_items (
        delivery_id,
        account_id,
        domain_id,
        content_id,
        visibility_version,
        ordinal
      )
      SELECT delivery.id,
             ${input.accountId},
             ${input.domainId},
             candidate.content_id,
             candidate.visibility_version,
             candidate.ordinal
      FROM delivery
      CROSS JOIN candidates AS candidate
      ON CONFLICT DO NOTHING
      RETURNING delivery_id
    )
    SELECT delivery.id AS delivery_id,
           count(inserted_items.delivery_id)::integer AS item_count
    FROM delivery
    LEFT JOIN inserted_items ON inserted_items.delivery_id = delivery.id
    GROUP BY delivery.id
  `;
  const row = rows[0];
  return row
    ? { deliveryId: row.delivery_id, itemCount: row.item_count }
    : null;
}

interface ClaimedDeliveryRow {
  account_id: string;
  attempts: number;
  domain_id: string;
  id: string;
  local_date: string;
  locked_by: string;
  max_attempts: number;
}

export interface ClaimedDigestDelivery {
  accountId: string;
  attempts: number;
  domainId: string;
  id: string;
  localDate: string;
  lockedBy: string;
  maxAttempts: number;
}

export async function claimNextDigestDelivery(
  sql: DigestSql,
  input: { leaseMs: number; now: Date; workerId: string },
): Promise<ClaimedDigestDelivery | null> {
  const claimToken = `${input.workerId}:${globalThis.crypto.randomUUID()}`;
  const staleBefore = new Date(input.now.getTime() - input.leaseMs).toISOString();
  const now = input.now.toISOString();
  const rows = await sql<ClaimedDeliveryRow[]>`
    WITH candidate AS (
      SELECT id
      FROM digest_email_deliveries
      WHERE attempts < max_attempts
        AND (
          (status = 'pending' AND available_at <= ${now})
          OR (status = 'sending' AND locked_at <= ${staleBefore})
        )
      ORDER BY available_at ASC, created_at ASC, id ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE digest_email_deliveries AS delivery
    SET status = 'sending',
        attempts = delivery.attempts + 1,
        locked_at = ${now},
        locked_by = ${claimToken},
        skipped_reason = NULL,
        last_error_code = NULL,
        updated_at = ${now}
    FROM candidate
    WHERE delivery.id = candidate.id
    RETURNING delivery.id,
              delivery.account_id,
              delivery.domain_id,
              delivery.local_date,
              delivery.attempts,
              delivery.max_attempts,
              delivery.locked_by
  `;
  const row = rows[0];
  return row
    ? {
        accountId: row.account_id,
        attempts: row.attempts,
        domainId: row.domain_id,
        id: row.id,
        localDate: row.local_date,
        lockedBy: row.locked_by,
        maxAttempts: row.max_attempts,
      }
    : null;
}

export async function reapExhaustedDigestDeliveries(
  sql: DigestSql,
  input: { leaseMs: number; now: Date },
): Promise<number> {
  const staleBefore = new Date(input.now.getTime() - input.leaseMs).toISOString();
  const rows = await sql<{ count: number }[]>`
    WITH transitioned AS (
      UPDATE digest_email_deliveries
      SET status = 'failed',
          locked_at = NULL,
          locked_by = NULL,
          last_error_code = 'lease_expired',
          updated_at = ${input.now.toISOString()}
      WHERE status = 'sending'
        AND attempts >= max_attempts
        AND locked_at <= ${staleBefore}
      RETURNING id
    )
    SELECT count(*)::integer AS count FROM transitioned
  `;
  return rows[0]?.count ?? 0;
}

interface DeliveryContextRow {
  domain_name: string;
  primary_email: string;
}

export async function loadCurrentDeliveryContext(
  sql: DigestSql,
  deliveryId: string,
): Promise<{ domainName: string; email: string } | null> {
  const rows = await sql<DeliveryContextRow[]>`
    SELECT domain.name AS domain_name,
           account.primary_email
    FROM digest_email_deliveries AS delivery
    JOIN account_digest_preferences AS preference
      ON preference.account_id = delivery.account_id
     AND preference.enabled = true
    JOIN domain_digest_subscriptions AS subscription
      ON subscription.account_id = delivery.account_id
     AND subscription.domain_id = delivery.domain_id
     AND subscription.active = true
    JOIN accounts AS account
      ON account.id = delivery.account_id
     AND account.status = 'active'
     AND account.primary_email IS NOT NULL
     AND account.email_verified_at IS NOT NULL
    JOIN domains AS domain
      ON domain.id = delivery.domain_id
     AND domain.active = true
    WHERE delivery.id = ${deliveryId}
    LIMIT 1
  `;
  const row = rows[0];
  return row ? { domainName: row.domain_name, email: row.primary_email } : null;
}

interface ValidItemRow {
  ai_summary: string | null;
  author: string | null;
  public_id: string;
  source: string;
  summary_status: "failed" | "pending" | "ready" | "unavailable";
  title: string | null;
}

export interface ValidDigestItem {
  author: string | null;
  publicId: string;
  source: string;
  summary: string | null;
  summaryStatus: "failed" | "pending" | "ready" | "unavailable";
  title: string | null;
}

export async function revalidateDigestItems(
  sql: DigestSql,
  deliveryId: string,
): Promise<ValidDigestItem[]> {
  const rows = await sql<ValidItemRow[]>`
    WITH valid AS MATERIALIZED (
      SELECT item.id AS item_id,
             item.ordinal,
             public_content.public_id,
             public_content.title,
             public_content.author,
             public_content.source,
             public_content.ai_summary,
             public_content.summary_status
      FROM digest_email_delivery_items AS item
      JOIN public_contents_current AS public_content
        ON public_content.id = item.content_id
       AND public_content.visibility_version = item.visibility_version
       AND public_content.summary_status <> 'hidden'
      WHERE item.delivery_id = ${deliveryId}
        AND EXISTS (
          SELECT 1
          FROM collections AS collection
          JOIN filter_profiles AS filter
            ON filter.account_id = collection.account_id
           AND filter.active = true
           AND filter.revoked_at IS NULL
          JOIN accounts AS filter_account
            ON filter_account.id = collection.account_id
           AND filter_account.status = 'active'
          JOIN domains AS domain
            ON domain.id = collection.domain_id
           AND domain.active = true
          WHERE collection.content_id = public_content.id
            AND collection.domain_id = item.domain_id
            AND collection.collection_status = 'active'
            AND collection.visibility = 'public'
            AND collection.public_since IS NOT NULL
            AND collection.filter_revoked_at IS NULL
            AND collection.moderation_status = 'clear'
        )
    ), deleted AS (
      DELETE FROM digest_email_delivery_items AS item
      WHERE item.delivery_id = ${deliveryId}
        AND NOT EXISTS (
          SELECT 1 FROM valid WHERE valid.item_id = item.id
        )
      RETURNING item.id
    )
    SELECT valid.public_id,
           valid.title,
           valid.author,
           valid.source,
           valid.ai_summary,
           valid.summary_status
    FROM valid
    CROSS JOIN (SELECT count(*) FROM deleted) AS deletion_count
    ORDER BY valid.ordinal ASC
  `;
  return rows.map((row) => ({
    author: row.author,
    publicId: row.public_id,
    source: row.source,
    summary: row.ai_summary,
    summaryStatus: row.summary_status,
    title: row.title,
  }));
}

export async function markDigestDeliverySkipped(
  sql: DigestSql,
  input: { claimToken: string; deliveryId: string; now: Date; reason: string },
): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    UPDATE digest_email_deliveries
    SET status = 'skipped',
        skipped_reason = ${input.reason},
        locked_at = NULL,
        locked_by = NULL,
        updated_at = ${input.now.toISOString()}
    WHERE id = ${input.deliveryId}
      AND status = 'sending'
      AND locked_by = ${input.claimToken}
    RETURNING id
  `;
  return rows.length === 1;
}

export async function completeDigestDelivery(
  sql: DigestSql,
  input: {
    claimToken: string;
    deliveryId: string;
    email: string;
    now: Date;
    providerMessageId: string | null;
  },
): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    UPDATE digest_email_deliveries
    SET status = 'sent',
        recipient_email = ${input.email},
        sent_at = ${input.now.toISOString()},
        provider_message_id = ${input.providerMessageId},
        locked_at = NULL,
        locked_by = NULL,
        last_error_code = NULL,
        updated_at = ${input.now.toISOString()}
    WHERE id = ${input.deliveryId}
      AND status = 'sending'
      AND locked_by = ${input.claimToken}
    RETURNING id
  `;
  return rows.length === 1;
}

export async function failDigestDelivery(
  sql: DigestSql,
  input: {
    baseRetryMs: number;
    delivery: ClaimedDigestDelivery;
    errorCode: string;
    maxRetryMs: number;
    now: Date;
    random?: () => number;
  },
): Promise<"failed" | "pending" | "lease_lost"> {
  const terminal = input.delivery.attempts >= input.delivery.maxAttempts;
  const exponent = Math.max(0, input.delivery.attempts - 1);
  const unjittered = Math.min(input.maxRetryMs, input.baseRetryMs * 2 ** exponent);
  const jitter = 0.8 + (input.random ?? Math.random)() * 0.4;
  const retryAt = new Date(
    input.now.getTime() + Math.min(input.maxRetryMs, Math.round(unjittered * jitter)),
  );
  const status = terminal ? "failed" : "pending";
  const rows = await sql<{ id: string }[]>`
    UPDATE digest_email_deliveries
    SET status = ${status}::digest_delivery_status,
        available_at = ${terminal ? input.now.toISOString() : retryAt.toISOString()},
        locked_at = NULL,
        locked_by = NULL,
        last_error_code = ${input.errorCode},
        updated_at = ${input.now.toISOString()}
    WHERE id = ${input.delivery.id}
      AND status = 'sending'
      AND locked_by = ${input.delivery.lockedBy}
    RETURNING id
  `;
  return rows.length === 1 ? status : "lease_lost";
}
