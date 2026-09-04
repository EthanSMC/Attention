import { describe, expect, it } from "vitest";

import {
  buildFirstTurnPrompt,
  buildFollowUpPrompt,
  buildSummaryRetryNoticePrompt,
  buildSummaryRetryPrompt,
} from "./prompt";

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
    expect(prompt).toMatch(/标题.*最终公开链接.*摘要.*标签/u);
    expect(prompt).toMatch(/收藏结果的最终回复不得包含.*原始 URL.*原始标题.*页面正文.*摘要.*标签/u);
    expect(prompt).toMatch(/最多 2000 字符/u);
    expect(prompt).toMatch(/1–8 个/u);
    expect(prompt).toMatch(/already_enriched[\s\S]*成功/u);
    expect(prompt).toMatch(/无法公开读取[\s\S]*保持待补全[\s\S]*仍然确认收藏成功/u);
    expect(prompt).toMatch(/不要编造/u);
    expect(prompt).toMatch(/只提交标题、最终公开链接、摘要和标签/u);
    expect(prompt).toMatch(/不要提交[^\n]*页面正文[^\n]*Cookie[^\n]*授权信息[^\n]*浏览器状态/u);
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

  it("automatically enriches an eligible missing summary returned by status", () => {
    const prompt = buildFirstTurnPrompt({
      messageRef: "msg-recover-summary",
      userMessage: "处理一下刚才待补全的摘要",
    });

    expect(prompt).toMatch(
      /attention_get_collection_status[\s\S]*enrichment_action=`generate_summary`[\s\S]*public_read_url/u,
    );
    expect(prompt).toMatch(/无需再次询问或确认/u);
    expect(prompt).toMatch(
      /只使用[^\n]*public_read_url[\s\S]*attention_submit_content_enrichment/u,
    );
  });

  it("explains local retry state without exposing collection identifiers", () => {
    const prompt = buildFollowUpPrompt({
      messageRef: "msg-status",
      retryContext: {
        active: 1,
        nextAttemptAt: "2026-09-04T08:02:00.000Z",
        paused: 0,
        running: 0,
      },
      userMessage: "在做了吗",
    });

    expect(prompt).toContain(
      "pending 只表示摘要未完成，不代表服务端后台任务正在运行",
    );
    expect(prompt).toContain("已安排 1 项本地自动重试");
    expect(prompt).toContain("2026-09-04T08:02:00.000Z");
    expect(prompt).not.toMatch(/[0-9a-f]{8}-[0-9a-f-]{27,}/iu);
  });

  it("builds an exact status-first prompt for an automatic retry", () => {
    const prompt = buildSummaryRetryPrompt({
      automaticAttempt: 1,
      collectionId: "11111111-1111-4111-8111-111111111111",
      retryRef:
        "summary-retry-0123456789abcdef0123456789abcdef0123456789abcdef",
    });

    expect(prompt).toContain("先调用 attention_get_collection_status");
    expect(prompt).toContain("11111111-1111-4111-8111-111111111111");
    expect(prompt).toMatch(/只使用[^\n]*public_read_url/u);
    expect(prompt).toContain("不得从聊天历史或原始分享文本猜测");
    expect(prompt).toContain("不要声称后台仍在生成");
  });

  it.each(["paused", "terminal"] as const)(
    "builds a content-free disposable %s notice prompt",
    (phase) => {
      const prompt = buildSummaryRetryNoticePrompt({ phase });
      expect(prompt).toContain("不得调用任何工具");
      expect(prompt).not.toContain("collection_id");
      expect(prompt).not.toMatch(/https?:\/\//u);
      expect(prompt).not.toMatch(/[0-9a-f]{8}-[0-9a-f-]{27,}/iu);
    },
  );
});
