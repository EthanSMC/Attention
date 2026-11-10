import { describe, expect, it } from "vitest";

import { websiteAgentAccountEligible, websiteAgentAvailableFor, websiteAgentConfig } from "./website-agent-config";

const accountId = "00000000-0000-4000-8000-000000000001";
const anotherAccountId = "00000000-0000-4000-8000-000000000002";
const enabled = {
  ATTENTION_WEBSITE_AGENT_ENABLED: "true", ATTENTION_WEBSITE_AGENT_ACCOUNT_IDS: accountId,
  ATTENTION_WEBSITE_AGENT_DEEPSEEK_API_KEY: "synthetic-key", ATTENTION_WEBSITE_AGENT_DAILY_COST_MICRO_USD: "unlimited",
  ATTENTION_WEBSITE_AGENT_SESSION_SECRET: "independent-synthetic-website-session-encryption-key",
};

describe("website agent rollout configuration", () => {
  it("is off unless explicitly enabled even if another AI key exists", () => {
    expect(() => websiteAgentConfig({ ATTENTION_AI_API_KEY: "other-provider" })).toThrow("website_agent_disabled");
  });
  it("supports the explicitly selected unlimited daily budget while retaining finite per-run resources", () => {
    expect(websiteAgentConfig(enabled)).toMatchObject({ audience: "allowlist", dailyCostMicrousd: null, maxRunCostMicrousd: 400_000, apiKey: "synthetic-key" });
  });
  it.each([
    { ATTENTION_WEBSITE_AGENT_AUDIENCE: "" },
    { ATTENTION_WEBSITE_AGENT_AUDIENCE: "public" },
    { ATTENTION_WEBSITE_AGENT_AUDIENCE: "all" },
    { ATTENTION_WEBSITE_AGENT_ACCOUNT_IDS: "" },
    { ATTENTION_WEBSITE_AGENT_DEEPSEEK_API_KEY: "" },
    { ATTENTION_WEBSITE_AGENT_ACCOUNT_IDS: "all" },
    { ATTENTION_WEBSITE_AGENT_ACCOUNT_IDS: `${accountId},${accountId}` },
    { ATTENTION_WEBSITE_AGENT_DAILY_COST_MICRO_USD: "" },
    { ATTENTION_WEBSITE_AGENT_DAILY_COST_MICRO_USD: "NaN" },
    { ATTENTION_WEBSITE_AGENT_DAILY_COST_MICRO_USD: "-1" },
    { ATTENTION_WEBSITE_AGENT_MAX_RUN_COST_MICRO_USD: "0" },
    { ATTENTION_WEBSITE_AGENT_SESSION_SECRET: "" },
    { ATTENTION_HMAC_SECRET: "independent-synthetic-website-session-encryption-key" },
    { ATTENTION_WEBSITE_AGENT_DEEPSEEK_API_KEY: "independent-synthetic-website-session-encryption-key" },
  ])("fails closed for missing or invalid activation settings: %s", change => {
    expect(() => websiteAgentConfig({ ...enabled, ...change })).toThrow("website_agent_not_configured");
  });
  it("checks the exact server-owned account allowlist", () => {
    expect(websiteAgentAvailableFor(accountId, enabled)).toBe(true);
    expect(websiteAgentAvailableFor(anotherAccountId, enabled)).toBe(false);
    expect(websiteAgentAvailableFor(anotherAccountId, { ...enabled, ATTENTION_WEBSITE_AGENT_AUDIENCE: "allowlist" })).toBe(false);
    expect(websiteAgentAvailableFor(accountId, {})).toBe(false);
  });
  it("supports multiple exact accounts without opening the default allowlist", () => {
    const config = websiteAgentConfig({ ...enabled, ATTENTION_WEBSITE_AGENT_ACCOUNT_IDS: `${accountId}, ${anotherAccountId}` });
    expect(config.accountIds).toEqual([accountId, anotherAccountId]);
    expect(websiteAgentAccountEligible(config, anotherAccountId)).toBe(true);
    expect(websiteAgentAccountEligible(config, "00000000-0000-4000-8000-000000000003")).toBe(false);
  });
  it("explicitly permits every authenticated Member account in members mode without listing accounts", () => {
    const env = { ...enabled, ATTENTION_WEBSITE_AGENT_AUDIENCE: "members", ATTENTION_WEBSITE_AGENT_ACCOUNT_IDS: "" };
    expect(websiteAgentConfig(env)).toMatchObject({ audience: "members", accountIds: [] });
    expect(websiteAgentAvailableFor(accountId, env)).toBe(true);
    expect(websiteAgentAvailableFor(anotherAccountId, env)).toBe(true);
    expect(websiteAgentConfig({ ...env, ATTENTION_WEBSITE_AGENT_ACCOUNT_IDS: undefined }).accountIds).toEqual([]);
  });
  it.each([accountId, "all", ",", ` ${accountId} `])("rejects ambiguous members mode with a nonempty allowlist: %s", accounts => {
    expect(() => websiteAgentConfig({ ...enabled, ATTENTION_WEBSITE_AGENT_AUDIENCE: "members", ATTENTION_WEBSITE_AGENT_ACCOUNT_IDS: accounts })).toThrow("website_agent_not_configured");
  });
  it.each([
    { ATTENTION_WEBSITE_AGENT_ENABLED: "false" },
    { ATTENTION_WEBSITE_AGENT_DEEPSEEK_API_KEY: "" },
    { ATTENTION_WEBSITE_AGENT_SESSION_SECRET: "" },
    { ATTENTION_WEBSITE_AGENT_DAILY_COST_MICRO_USD: "" },
    { ATTENTION_WEBSITE_AGENT_MAX_RUN_COST_MICRO_USD: "0" },
  ])("does not let members mode bypass activation, secrets or budgets: %s", change => {
    const env = { ...enabled, ATTENTION_WEBSITE_AGENT_AUDIENCE: "members", ATTENTION_WEBSITE_AGENT_ACCOUNT_IDS: "", ...change };
    expect(() => websiteAgentConfig(env)).toThrow();
    expect(websiteAgentAvailableFor(accountId, env)).toBe(false);
  });
});
