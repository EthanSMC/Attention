import { readFile } from "node:fs/promises";

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
  "attention_collect_content",
  "attention_get_collection_status",
  "attention_list_collections",
  "attention_list_public_content",
  "attention_search_content",
  "attention_select_collection_candidate",
  "attention_update_collection",
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

    expect(ATTENTION_TOOL_CONTRACT_VERSION).toBe("1.0.0");
    expect(skill).toContain("Skill ID: `attention`");
    expect(skill).toContain("Skill version: `1.0.0`");
    expect(skill).toContain(
      `Tool contract version: \`${ATTENTION_TOOL_CONTRACT_VERSION}\``,
    );
    expect(registryNames).toEqual([...expectedPublicTools]);
    expect(declaredToolNames(skill)).toEqual(registryNames);
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
    expect(skill).toMatch(/still call `attention_collect_content` with the original URL/u);
    expect(skill).toMatch(/Agent's own Browser, Computer Use, or Web Search/u);
    expect(skill).toMatch(/Third-party extraction is not trusted Attention acquisition evidence/u);
    expect(skill).toMatch(/Only an active Filter may make a collection public/u);
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
