import { readFile } from "node:fs/promises";

import { ATTENTION_SKILL_PACKAGE_VERSION } from "@attention/contracts";
import { describe, expect, it } from "vitest";

import {
  ATTENTION_PUBLIC_TOOL_NAMES,
  ATTENTION_TOOL_CONTRACT_VERSION,
} from "./attention-tool-registry";

const publicSkillUrl = new URL(
  "../../public/skills/attention/SKILL.md",
  import.meta.url,
);

const expectedPublicTools = [
  "attention_cast_moderation_vote",
  "attention_collect_content",
  "attention_get_collection_status",
  "attention_get_digest_settings",
  "attention_get_membership_status",
  "attention_get_my_account",
  "attention_list_collections",
  "attention_list_moderation_cases",
  "attention_list_public_content",
  "attention_report_content",
  "attention_search_content",
  "attention_select_collection_candidate",
  "attention_submit_content_enrichment",
  "attention_update_collection",
  "attention_update_digest_settings",
] as const;

async function readPublicSkill(): Promise<string> {
  return readFile(publicSkillUrl, "utf8");
}

function declaredToolNames(skill: string): string[] {
  return [...new Set(skill.match(/attention_[a-z_]+/gu) ?? [])].sort();
}

describe("public Attention Skill contract", () => {
  it("matches the public Tool Registry and pinned contract version", async () => {
    const skill = await readPublicSkill();
    const registryNames = [...ATTENTION_PUBLIC_TOOL_NAMES].sort();

    expect(ATTENTION_TOOL_CONTRACT_VERSION).toBe("1.6.0");
    expect(skill).toContain("Skill ID: `attention`");
    expect(skill).toContain(
      `Skill version: \`${ATTENTION_SKILL_PACKAGE_VERSION}\``,
    );
    expect(skill).toContain(
      `Tool contract version: \`${ATTENTION_TOOL_CONTRACT_VERSION}\``,
    );
    expect(registryNames).toEqual([...expectedPublicTools]);
    expect(declaredToolNames(skill)).toEqual(registryNames);
  });

  it("pins the server-directed shared enrichment workflow and privacy boundary", async () => {
    const skill = await readPublicSkill();

    expect(skill).toMatch(/`reuse_summary`[\s\S]*do not read the source[\s\S]*do not call `attention_submit_content_enrichment`/u);
    expect(skill).toMatch(/`generate_summary`[\s\S]*publicly accessible source/u);
    expect(skill).toMatch(/summary[^\n]*2,000 characters/u);
    expect(skill).toMatch(/between 1 and 8 normalized tags/u);
    expect(skill).toMatch(/`title`, `resolved_url`, `summary`, and `tags`/u);
    expect(skill).toMatch(/`already_enriched`[\s\S]*successful reuse/u);
    expect(skill).toMatch(/cannot be read publicly[\s\S]*leave the summary pending/u);
    expect(skill).toMatch(/never fabricate/u);
    expect(skill).toMatch(/only the grounded title, final public URL, summary, and tags/u);
    expect(skill).toMatch(/Do not submit[^\n]*page text[^\n]*full content[^\n]*cookies[^\n]*authorization headers[^\n]*browser state/u);
  });

  it("re-enters the same enrichment workflow after candidate selection", async () => {
    const skill = await readPublicSkill();

    expect(skill).toMatch(
      /For `ambiguous`[\s\S]*Do not read any candidate source before the user selects/u,
    );
    expect(skill).toMatch(
      /`attention_select_collection_candidate`[\s\S]*same established-result handler/u,
    );
    expect(skill).toMatch(
      /selected result is `reuse_summary`[\s\S]*do not read[\s\S]*do not submit/u,
    );
    expect(skill).toMatch(
      /selected result is `generate_summary`[\s\S]*`public_read_url`[\s\S]*public reader[\s\S]*`attention_submit_content_enrichment`/u,
    );
    expect(skill).not.toMatch(
      /selected result is `generate_summary`[^\n]*`attention_get_collection_status`/u,
    );
    expect(skill).toMatch(/Never guess from the original multi-link share text/u);
  });

  it("automatically recovers an eligible missing summary from owner-scoped status", async () => {
    const skill = await readPublicSkill();

    expect(skill).toMatch(
      /attention_get_collection_status[\s\S]*generate_summary[\s\S]*do not ask for another confirmation/u,
    );
    expect(skill).toMatch(
      /exact absolute `content\.public_read_url`[\s\S]*attention_submit_content_enrichment/u,
    );
    expect(skill).toMatch(
      /reuse_summary[\s\S]*do not read or submit[\s\S]*none[\s\S]*unavailable[\s\S]*hidden/u,
    );
    expect(skill).toMatch(/Never substitute the original chat URL/u);
  });

  it("pins safe collection, recovery, and permission workflows", async () => {
    const skill = await readPublicSkill();

    expect(skill).toMatch(/stable, opaque `idempotency_key`/u);
    expect(skill).toMatch(/For every tool call, include `client_context`/u);
    expect(skill).toMatch(/one opaque `workflow_run_id` reused across that user workflow/u);
    expect(skill).toMatch(/reuse it for every retry/u);
    expect(skill).toMatch(/For `ambiguous`[\s\S]*ask the user to choose/u);
    expect(skill).toMatch(/Never guess a candidate/u);
    expect(skill).toMatch(/at most two automatic retries/u);
    expect(skill).toMatch(/Pass every established result[\s\S]*same established-result handler/u);
    expect(skill).toMatch(/Agent's own minimum public-web reader/u);
    expect(skill).toMatch(/bounded enrichment submission may include only its grounded title, final public URL, summary, and tags/u);
    expect(skill).toMatch(/Only an active Filter may make a collection public/u);
    expect(skill).toMatch(/Do not invent allegations/u);
    expect(skill).toMatch(/explicitly confirms that case and decision/u);
    expect(skill).toMatch(/Never manufacture confirmation/u);
    expect(skill).toMatch(/explicit_confirmation: true/u);
    expect(skill).toMatch(/do not transfer the old confirmation/u);
    expect(skill).toMatch(/Preserve values the user did not ask to change/u);
    expect(skill).toMatch(/## Optional device status sync/u);
    expect(skill).toMatch(/Only after the user explicitly agrees/u);
    expect(skill).toMatch(/Codex and Claude Code follow this same workflow/u);
    expect(skill).toMatch(/does not affect collection or WeChat/u);
    expect(skill).toMatch(/Do not retry through a public or anonymous endpoint to bypass it/u);
  });

  it("does not embed credentials or instruct agents to persist original content", async () => {
    const skill = await readPublicSkill();

    expect(skill).not.toMatch(/att_pat_[A-Za-z0-9_-]+/u);
    expect(skill).not.toMatch(/Bearer\s+[A-Za-z0-9._~-]+/u);
    expect(skill).not.toMatch(/store (?:the )?(?:full )?(?:page|article|original|HTML)/iu);
    expect(skill).toMatch(/Do not submit copied page text, extracted full content, cookies, authorization headers, or browser state/u);
    expect(skill).toMatch(/stores collected URLs and necessary metadata, not a third-party original/u);
  });
});
