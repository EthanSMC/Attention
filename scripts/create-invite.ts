/// <reference types="node" />

import process from "node:process";

import { createInvitation } from "../packages/auth/src/index";
import { createDatabase } from "../packages/db/src/index";

interface CliOptions {
  kind: "member" | "filter";
  handle?: string;
  accountId?: string;
  displayName?: string;
  createdByAccountId?: string;
  expiresHours: number;
  baseUrl: string;
}

function usage(): never {
  throw new Error(
    [
      "Usage:",
      "  pnpm --filter @attention/db exec tsx ../../scripts/create-invite.ts \\",
      "    --kind <member|filter> (--handle <stable-handle> | --account-id <uuid>) \\",
      "    [--display-name <name>] [--expires-hours <hours>] [--base-url <url>]",
      "",
      "DATABASE_URL must be set. The raw token is printed once and is never stored."
    ].join("\n")
  );
}

function readFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) {
    return undefined;
  }
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    usage();
  }
  return value;
}

function parseOptions(args: string[]): CliOptions {
  const kind = readFlag(args, "--kind");
  if (kind !== "member" && kind !== "filter") {
    usage();
  }

  const handle = readFlag(args, "--handle");
  const accountId = readFlag(args, "--account-id");
  if (Boolean(handle) === Boolean(accountId)) {
    usage();
  }

  const expiresHoursRaw = readFlag(args, "--expires-hours") ?? "168";
  const expiresHours = Number(expiresHoursRaw);
  if (!Number.isFinite(expiresHours) || expiresHours <= 0 || expiresHours > 24 * 30) {
    throw new Error("--expires-hours must be greater than 0 and at most 720");
  }

  const baseUrl = readFlag(args, "--base-url") ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const parsedBaseUrl = new URL(baseUrl);
  if (parsedBaseUrl.protocol !== "http:" && parsedBaseUrl.protocol !== "https:") {
    throw new Error("--base-url must use HTTP(S)");
  }

  const options: CliOptions = {
    kind,
    expiresHours,
    baseUrl: parsedBaseUrl.toString().replace(/\/$/, "")
  };
  if (handle) options.handle = handle;
  if (accountId) options.accountId = accountId;
  const displayName = readFlag(args, "--display-name");
  if (displayName) options.displayName = displayName;
  const createdByAccountId = readFlag(args, "--created-by-account-id");
  if (createdByAccountId) options.createdByAccountId = createdByAccountId;
  return options;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  const options = parseOptions(process.argv.slice(2));
  const now = new Date();
  const handle = createDatabase(databaseUrl, { maxConnections: 1 });

  try {
    const invitationInput: Parameters<typeof createInvitation>[1] = {
      kind: options.kind,
      now,
      expiresAt: new Date(now.getTime() + options.expiresHours * 60 * 60 * 1_000)
    };
    if (options.handle) invitationInput.stableHandle = options.handle;
    if (options.accountId) invitationInput.accountId = options.accountId;
    if (options.displayName) invitationInput.filterDisplayName = options.displayName;
    if (options.createdByAccountId) invitationInput.createdByAccountId = options.createdByAccountId;

    const invitation = await createInvitation(handle.db, invitationInput);
    const inviteUrl = `${options.baseUrl}/invite/${encodeURIComponent(invitation.token)}`;
    process.stdout.write(
      [
        `invitation_id=${invitation.invitationId}`,
        `account_id=${invitation.accountId}`,
        `kind=${invitation.kind}`,
        `expires_at=${invitation.expiresAt.toISOString()}`,
        `invite_url=${inviteUrl}`
      ].join("\n") + "\n"
    );
  } finally {
    await handle.close();
  }
}

await main();
