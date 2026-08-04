import "server-only";

import { resolveAccountCapabilities } from "@attention/auth";
import {
  accountDigestPreferences,
  and,
  domainDigestSubscriptions,
  domains,
  eq,
  inArray,
  sql,
  type AttentionDatabase,
  type AttentionTransaction,
} from "@attention/db";

export const defaultDigestTimezone = "Asia/Shanghai";
export const defaultDigestWindowStartMinute = 8 * 60;
export const defaultDigestWindowMinutes = 60;

export interface DigestDomainSetting {
  active: boolean;
  name: string;
  slug: string;
}

export interface DigestSettings {
  domains: DigestDomainSetting[];
  enabled: boolean;
  timezone: string;
  windowStart: string;
  windowMinutes: number;
}

export interface UpdateDigestSettingsInput {
  domainSlugs: string[];
  enabled: boolean;
  timezone: string;
  windowMinutes: number;
  windowStart: string;
}

export class DigestSettingsError extends Error {
  constructor(
    readonly code: "digest_entitlement_required" | "invalid_digest_settings",
  ) {
    super(code);
    this.name = "DigestSettingsError";
  }
}

export function isValidTimeZone(timezone: string): boolean {
  if (!timezone || timezone.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

export function parseWindowStart(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/u.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

export function formatWindowStart(value: number): string {
  const hour = Math.floor(value / 60).toString().padStart(2, "0");
  const minute = (value % 60).toString().padStart(2, "0");
  return `${hour}:${minute}`;
}

function validateUpdate(input: UpdateDigestSettingsInput): {
  domainSlugs: string[];
  sendWindowStartMinute: number;
} {
  const sendWindowStartMinute = parseWindowStart(input.windowStart);
  const domainSlugs = [...new Set(input.domainSlugs)];
  if (
    sendWindowStartMinute === null ||
    !isValidTimeZone(input.timezone) ||
    !Number.isInteger(input.windowMinutes) ||
    input.windowMinutes < 15 ||
    input.windowMinutes > 240 ||
    sendWindowStartMinute + input.windowMinutes > 1440 ||
    domainSlugs.length !== input.domainSlugs.length ||
    domainSlugs.length > 20 ||
    domainSlugs.some((slug) => !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(slug))
  ) {
    throw new DigestSettingsError("invalid_digest_settings");
  }
  return { domainSlugs, sendWindowStartMinute };
}

async function loadInsideTransaction(
  tx: AttentionTransaction,
  accountId: string,
): Promise<DigestSettings> {
  const [preference, domainRows] = await Promise.all([
    tx
      .select({
        enabled: accountDigestPreferences.enabled,
        sendWindowMinutes: accountDigestPreferences.sendWindowMinutes,
        sendWindowStartMinute: accountDigestPreferences.sendWindowStartMinute,
        timezone: accountDigestPreferences.timezone,
      })
      .from(accountDigestPreferences)
      .where(eq(accountDigestPreferences.accountId, accountId))
      .limit(1),
    tx
      .select({
        active: domainDigestSubscriptions.active,
        name: domains.name,
        slug: domains.slug,
      })
      .from(domains)
      .leftJoin(
        domainDigestSubscriptions,
        and(
          eq(domainDigestSubscriptions.domainId, domains.id),
          eq(domainDigestSubscriptions.accountId, accountId),
        ),
      )
      .where(eq(domains.active, true))
      .orderBy(domains.name),
  ]);
  const current = preference[0];
  return {
    domains: domainRows.map((domain) => ({
      active: domain.active ?? false,
      name: domain.name,
      slug: domain.slug,
    })),
    enabled: current?.enabled ?? true,
    timezone: current?.timezone ?? defaultDigestTimezone,
    windowMinutes: current?.sendWindowMinutes ?? defaultDigestWindowMinutes,
    windowStart: formatWindowStart(
      current?.sendWindowStartMinute ?? defaultDigestWindowStartMinute,
    ),
  };
}

export async function loadDigestSettings(
  db: AttentionDatabase,
  accountId: string,
): Promise<DigestSettings> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.account_id', ${accountId}, true)`);
    return loadInsideTransaction(tx, accountId);
  });
}

export async function updateDigestSettings(
  db: AttentionDatabase,
  accountId: string,
  input: UpdateDigestSettingsInput,
): Promise<DigestSettings> {
  const validated = validateUpdate(input);
  const capabilities = await resolveAccountCapabilities(db, accountId);
  if (!capabilities.isMember && !capabilities.isFilter) {
    throw new DigestSettingsError("digest_entitlement_required");
  }

  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.account_id', ${accountId}, true)`);
    const selectedDomains = validated.domainSlugs.length
      ? await tx
          .select({ id: domains.id, slug: domains.slug })
          .from(domains)
          .where(
            and(
              eq(domains.active, true),
              inArray(domains.slug, validated.domainSlugs),
            ),
          )
      : [];
    if (selectedDomains.length !== validated.domainSlugs.length) {
      throw new DigestSettingsError("invalid_digest_settings");
    }

    const now = new Date();
    await tx
      .insert(accountDigestPreferences)
      .values({
        accountId,
        enabled: input.enabled,
        sendWindowMinutes: input.windowMinutes,
        sendWindowStartMinute: validated.sendWindowStartMinute,
        timezone: input.timezone,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        set: {
          enabled: input.enabled,
          sendWindowMinutes: input.windowMinutes,
          sendWindowStartMinute: validated.sendWindowStartMinute,
          timezone: input.timezone,
          updatedAt: now,
        },
        target: accountDigestPreferences.accountId,
      });

    await tx
      .update(domainDigestSubscriptions)
      .set({ active: false, updatedAt: now })
      .where(eq(domainDigestSubscriptions.accountId, accountId));
    if (selectedDomains.length > 0) {
      await tx
        .insert(domainDigestSubscriptions)
        .values(
          selectedDomains.map((domain) => ({
            accountId,
            active: true,
            domainId: domain.id,
            updatedAt: now,
          })),
        )
        .onConflictDoUpdate({
          set: { active: true, updatedAt: now },
          target: [
            domainDigestSubscriptions.accountId,
            domainDigestSubscriptions.domainId,
          ],
        });
    }
    return loadInsideTransaction(tx, accountId);
  });
}
