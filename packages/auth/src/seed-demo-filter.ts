import process from "node:process";

import {
  accounts,
  createDatabase,
  entitlements,
  eq,
  filterProfiles,
  sql,
} from "@attention/db";

import { currentPrivacyVersion, currentTermsVersion, normalizeEmail } from "./email-auth";
import { hashPassword } from "./passwords";

const demoEmail = "filter_dev@attention.com";
const demoStableHandle = "filter-dev-demo";
const demoDisplayName = "Filter 体验账号";

function readRequiredSecret(): string {
  const password = process.env.ATTENTION_DEMO_FILTER_PASSWORD;
  if (!password) {
    throw new Error("ATTENTION_DEMO_FILTER_PASSWORD is required and is never stored in the repository");
  }
  return password;
}

async function main(): Promise<void> {
  if (process.env.ATTENTION_SEED_DEMO_FILTER !== "1") {
    throw new Error("refusing to seed the demo Filter account without ATTENTION_SEED_DEMO_FILTER=1");
  }

  const databaseUrl = process.env.MIGRATION_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("MIGRATION_DATABASE_URL is required for the demo account seed");
  }

  const passwordHash = await hashPassword(readRequiredSecret());
  const email = normalizeEmail(demoEmail);
  const now = new Date();
  const handle = createDatabase(databaseUrl, { maxConnections: 1, prepare: false });

  try {
    const result = await handle.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`demo-filter-account:${email}`}, 0))`,
      );

      let [account] = await tx
        .select({
          id: accounts.id,
          displayName: accounts.displayName,
          stableHandle: accounts.stableHandle,
        })
        .from(accounts)
        .where(eq(accounts.primaryEmail, email))
        .limit(1);

      if (account) {
        const [updated] = await tx
          .update(accounts)
          .set({
            emailVerifiedAt: now,
            passwordHash,
            status: "active",
            termsAcceptedAt: now,
            termsVersion: currentTermsVersion,
            privacyVersion: currentPrivacyVersion,
            updatedAt: now,
          })
          .where(eq(accounts.id, account.id))
          .returning({
            id: accounts.id,
            displayName: accounts.displayName,
            stableHandle: accounts.stableHandle,
          });
        if (!updated) throw new Error("demo Filter account update returned no row");
        account = updated;
      } else {
        const [created] = await tx
          .insert(accounts)
          .values({
            displayName: demoDisplayName,
            emailVerifiedAt: now,
            passwordHash,
            primaryEmail: email,
            stableHandle: demoStableHandle,
            status: "active",
            termsAcceptedAt: now,
            termsVersion: currentTermsVersion,
            privacyVersion: currentPrivacyVersion,
          })
          .returning({
            id: accounts.id,
            displayName: accounts.displayName,
            stableHandle: accounts.stableHandle,
          });
        if (!created) throw new Error("demo Filter account insert returned no row");
        account = created;
      }

      await tx
        .insert(filterProfiles)
        .values({
          accountId: account.id,
          active: true,
          displayName: account.displayName,
          revokedAt: null,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: filterProfiles.accountId,
          set: {
            active: true,
            displayName: account.displayName,
            revokedAt: null,
            updatedAt: now,
          },
        });

      await tx
        .insert(entitlements)
        .values({
          accountId: account.id,
          endsAt: null,
          memberEnabled: true,
          source: "admin_grant",
          startsAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [entitlements.accountId, entitlements.source],
          set: {
            endsAt: null,
            memberEnabled: true,
            startsAt: now,
            updatedAt: now,
          },
        });

      return account;
    });

    process.stdout.write(
      [
        "demo Filter account ready",
        `email=${demoEmail}`,
        `account_id=${result.id}`,
        `display_name=${result.displayName}`,
        `stable_handle=${result.stableHandle}`,
        "filter_profile=active",
        "member_entitlement=admin_grant",
      ].join("\n") + "\n",
    );
  } finally {
    await handle.close();
  }
}

await main();
