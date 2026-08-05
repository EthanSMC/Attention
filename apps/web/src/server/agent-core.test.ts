import { describe, expect, it, vi } from "vitest";

import {
  AgentAccessError,
  answerAgentQuery,
  type AgentCandidate,
} from "./agent-core";

const mine: AgentCandidate = {
  author: "Ada",
  href: "/out/mine/1",
  id: "collection-1",
  key: "content-1",
  scope: "mine",
  source: "example.com",
  summary: "介绍检索增强生成与引用核对。",
  tags: ["RAG", "检索"],
  title: "RAG 实践",
};
const publicCandidate: AgentCandidate = {
  author: null,
  href: "/out/public/2",
  id: "public-2",
  key: "content-2",
  scope: "public",
  source: "public.example",
  summary: "另一篇 RAG 内容。",
  tags: ["RAG"],
  title: "RAG 公开资料",
};

describe("Agent retrieval core", () => {
  it("enforces Member access before returning private citations", async () => {
    await expect(answerAgentQuery({
      candidates: [mine],
      isMember: false,
      query: "RAG",
    })).rejects.toBeInstanceOf(AgentAccessError);
  });

  it("falls back to a query-specific deterministic answer when the provider fails", async () => {
    const result = await answerAgentQuery({
      candidates: [mine, publicCandidate],
      isMember: true,
      provider: { answer: vi.fn().mockRejectedValue(new Error("provider down")) },
      query: "RAG 检索",
    });
    expect(result.mode).toBe("deterministic");
    expect(result.answer).toContain("RAG 实践");
    expect(result.citations.map((item) => item.href)).toEqual([
      "/out/mine/1",
      "/out/public/2",
    ]);
  });

  it("only returns citations selected from the authorized retrieval set", async () => {
    const valid = await answerAgentQuery({
      candidates: [mine, publicCandidate],
      isMember: true,
      provider: {
        answer: vi.fn().mockResolvedValue({
          answer: "根据私人收藏可确认该主题。[1]",
          citedSourceKeys: [mine.key],
        }),
      },
      query: "RAG",
    });
    expect(valid).toMatchObject({
      citations: [{ href: "/out/mine/1", scope: "mine" }],
      mode: "generated",
    });

    const unknown = await answerAgentQuery({
      candidates: [mine],
      isMember: true,
      provider: {
        answer: vi.fn().mockResolvedValue({
          answer: "unsupported",
          citedSourceKeys: ["another-account-private-content"],
        }),
      },
      query: "RAG",
    });
    expect(unknown.mode).toBe("deterministic");
    expect(unknown.citations).toHaveLength(1);
    expect(unknown.citations[0]?.href).toBe("/out/mine/1");
  });
});
