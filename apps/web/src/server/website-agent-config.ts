import "server-only";

import { z } from "zod";

export class WebsiteAgentUnavailableError extends Error {
  constructor(readonly code: "website_agent_disabled" | "website_agent_not_configured") {
    super(code);
    this.name = "WebsiteAgentUnavailableError";
  }
}

export interface WebsiteAgentConfig {
  audience: "allowlist" | "members";
  accountIds: readonly string[];
  apiKey: string;
  dailyCostMicrousd: number | null;
  maxRunCostMicrousd: number;
}

const positiveBudget = z.coerce.number().int().min(1).max(100_000_000);

// Covers every allowed model/token/context round, rather than imposing an
// additional user spending cap. Daily billing can explicitly be unlimited.
const TECHNICAL_RUN_RESERVATION_MICRO_USD = 400_000;

/** No ambient AI key, fallback provider, implicit daily budget, or public rollout. */
export function websiteAgentConfig(env: Readonly<Record<string, string | undefined>> = process.env): WebsiteAgentConfig {
  if (env.ATTENTION_WEBSITE_AGENT_ENABLED !== "true") {
    throw new WebsiteAgentUnavailableError("website_agent_disabled");
  }
  const audience = z.enum(["allowlist", "members"]).safeParse(env.ATTENTION_WEBSITE_AGENT_AUDIENCE ?? "allowlist");
  const rawAccountIds = env.ATTENTION_WEBSITE_AGENT_ACCOUNT_IDS?.trim() ?? "";
  const accountIds = rawAccountIds.split(",").map(value => value.trim()).filter(Boolean);
  const accounts = z.array(z.string().uuid()).max(100).safeParse(accountIds);
  const daily = env.ATTENTION_WEBSITE_AGENT_DAILY_COST_MICRO_USD === "unlimited"
    ? { success: true as const, data: null }
    : positiveBudget.safeParse(env.ATTENTION_WEBSITE_AGENT_DAILY_COST_MICRO_USD);
  const perRun = env.ATTENTION_WEBSITE_AGENT_MAX_RUN_COST_MICRO_USD === undefined
    ? { success: true as const, data: TECHNICAL_RUN_RESERVATION_MICRO_USD }
    : positiveBudget.safeParse(env.ATTENTION_WEBSITE_AGENT_MAX_RUN_COST_MICRO_USD);
  const apiKey = env.ATTENTION_WEBSITE_AGENT_DEEPSEEK_API_KEY?.trim();
  const sessionSecret = env.ATTENTION_WEBSITE_AGENT_SESSION_SECRET?.trim();
  if (!audience.success || !accounts.success ||
      (audience.data === "members" ? rawAccountIds !== "" : accountIds.length === 0) ||
      new Set(accountIds).size !== accountIds.length || !daily.success ||
      !perRun.success || (daily.data !== null && perRun.data > daily.data) || !apiKey || !sessionSecret || sessionSecret.length < 32 ||
      sessionSecret === env.ATTENTION_HMAC_SECRET?.trim() || sessionSecret === env.ATTENTION_AUTH_SECRET?.trim() || sessionSecret === apiKey) {
    throw new WebsiteAgentUnavailableError("website_agent_not_configured");
  }
  return { audience: audience.data, accountIds, apiKey, dailyCostMicrousd: daily.data, maxRunCostMicrousd: perRun.data };
}

/** Rollout eligibility only. Callers must separately require a current authenticated Member. */
export function websiteAgentAccountEligible(config: WebsiteAgentConfig, accountId: string): boolean {
  return config.audience === "members" || config.accountIds.includes(accountId);
}

export function websiteAgentAvailableFor(accountId: string, env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  try { return websiteAgentAccountEligible(websiteAgentConfig(env), accountId); }
  catch { return false; }
}
