import { describe, expect, it } from "vitest";

import { buildFirstTurnPrompt } from "./prompt";

describe("channel intent", () => {
  it("uses the authenticated account role for the new-collection default", () => {
    const prompt = buildFirstTurnPrompt({
      messageRef: "msg-1",
      userMessage: "https://example.com/article",
    });

    expect(prompt).toContain("attention_get_my_account");
    expect(prompt).toContain("Filter");
    expect(prompt).toContain("默认 public");
    expect(prompt).toContain("Member");
    expect(prompt).toContain("默认 private");
    expect(prompt).not.toContain("visibility 默认 private");
  });

  it("collects before conditionally reading and submitting shared enrichment", () => {
    const prompt = buildFirstTurnPrompt({
      messageRef: "msg-enrich",
      userMessage: "https://example.com/article",
    });

    expect(prompt).toMatch(/先调用 attention_collect_content/u);
    expect(prompt).toMatch(/enrichment_action.*reuse_summary[\s\S]*不要读取原文[\s\S]*不要调用 attention_submit_content_enrichment/u);
    expect(prompt).toMatch(/enrichment_action.*generate_summary[\s\S]*公开可访问/u);
    expect(prompt).toContain("attention_submit_content_enrichment");
    expect(prompt).toMatch(/最多 2000 字符/u);
    expect(prompt).toMatch(/1–8 个/u);
    expect(prompt).toMatch(/already_enriched[\s\S]*成功/u);
    expect(prompt).toMatch(/无法公开读取[\s\S]*保持待补全[\s\S]*仍然确认收藏成功/u);
    expect(prompt).toMatch(/不要编造/u);
    expect(prompt).toMatch(/只提交摘要和标签/u);
    expect(prompt).toMatch(/不要[^\n]*页面正文[^\n]*原始 URL[^\n]*Cookie[^\n]*授权信息[^\n]*浏览器状态/u);
  });

  it("re-enters the established-result workflow after candidate selection", () => {
    const prompt = buildFirstTurnPrompt({
      messageRef: "msg-ambiguous",
      userMessage:
        "https://example.com/one https://example.net/two",
    });

    expect(prompt).toMatch(
      /ambiguous[\s\S]*不要读取任何候选原文[\s\S]*等待用户选择/u,
    );
    expect(prompt).toMatch(
      /attention_select_collection_candidate[\s\S]*同一个已建立收藏结果处理流程/u,
    );
    expect(prompt).toMatch(
      /选择结果.*reuse_summary[\s\S]*不要读取原文[\s\S]*不要调用 attention_submit_content_enrichment/u,
    );
    expect(prompt).toMatch(
      /选择结果.*generate_summary[\s\S]*public_read_url[\s\S]*公开读取[\s\S]*attention_submit_content_enrichment/u,
    );
    expect(prompt).not.toMatch(
      /选择结果.*generate_summary[^\n]*attention_get_collection_status/u,
    );
    expect(prompt).toMatch(/不要从原始多链接文案猜测/u);
  });
});
