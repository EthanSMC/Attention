"use client";

import { AgentDocNavigation, type AgentDocumentLink } from "./agent-doc-navigation";
import { TransientFeedback, useTransientFeedback } from "./transient-feedback";

export function AgentSkillDocument({
  agentLinks,
  canonicalSha256,
  canonicalUrl,
  workbuddySha256,
  workbuddyUrl,
}: {
  agentLinks: readonly AgentDocumentLink[];
  canonicalSha256: string | null;
  canonicalUrl: string | null;
  workbuddySha256: string | null;
  workbuddyUrl: string | null;
}) {
  const { feedback, showFeedback } = useTransientFeedback();

  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      showFeedback(`${label}已复制。`);
    } catch {
      showFeedback("复制失败，请重试。", "error");
    }
  }

  return (
    <div className="agent-doc-layout">
      <AgentDocNavigation activeSection="skill" agentLinks={agentLinks} />
      <article className="agent-doc-document">
        <header className="agent-doc-hero">
          <p>Attention 文档</p>
          <h1>Attention Skill</h1>
          <p>所有 Agent 使用同一份 Skill。宿主文档只负责说明加载方式，不再复制 Skill 内容。</p>
        </header>

        <section className="agent-doc-section" id="canonical">
          <p className="agent-doc-section__eyebrow">统一能力</p>
          <h2>一份 Skill，多个宿主</h2>
          <p>
            Skill 定义 Attention 的工作流、调用规则和失败处理。无论你使用 OpenClaw、Codex、Claude Code、Hermes 还是 WorkBuddy，加载的都是同一套版本。
          </p>
          <div className="agent-resource-list">
            <div className="agent-resource-row">
              <div><span>Skill 文件</span><code>{canonicalUrl ?? "尚未发布"}</code></div>
              {canonicalUrl ? <button onClick={() => copy(canonicalUrl, "Skill 地址")} type="button">复制</button> : null}
            </div>
            <div className="agent-resource-row agent-resource-row--digest">
              <div><span>SHA-256</span><code>{canonicalSha256 ?? "尚未发布"}</code></div>
              {canonicalSha256 ? <button onClick={() => copy(canonicalSha256, "SHA-256")} type="button">复制</button> : null}
            </div>
          </div>
        </section>

        <section className="agent-doc-section" id="distribution">
          <p className="agent-doc-section__eyebrow">发布形式</p>
          <h2>按宿主选择加载方式</h2>
          <p>远程宿主直接读取统一 Skill 文件；需要上传 ZIP 的宿主使用同一份内容的 bundle。版本和校验值保持一致。</p>
          <div className="agent-resource-list">
            <div className="agent-resource-row">
              <div><span>远程文件</span><code>OpenClaw · Hermes · Codex · Claude Code</code></div>
              <a className="agent-doc-inline-link" href="/doc">查看宿主文档 <span aria-hidden="true">↗</span></a>
            </div>
            <div className="agent-resource-row">
              <div><span>WorkBuddy bundle</span><code>{workbuddyUrl ?? "尚未发布"}</code></div>
              {workbuddyUrl ? <button onClick={() => copy(workbuddyUrl, "WorkBuddy bundle 地址")} type="button">复制</button> : null}
            </div>
            {workbuddySha256 ? (
              <div className="agent-resource-row agent-resource-row--digest">
                <div><span>WorkBuddy SHA-256</span><code>{workbuddySha256}</code></div>
                <button onClick={() => copy(workbuddySha256, "WorkBuddy SHA-256")} type="button">复制</button>
              </div>
            ) : null}
          </div>
        </section>

        <section className="agent-doc-section" id="next">
          <p className="agent-doc-section__eyebrow">下一步</p>
          <h2>选择你的 Agent</h2>
          <p>回到目录，进入对应宿主的文档，完成本机加载、MCP 添加和 OAuth 授权。</p>
          <a className="agent-doc-inline-link" href="/doc">返回 Agent 文档目录 <span aria-hidden="true">↗</span></a>
        </section>
      </article>
      <TransientFeedback feedback={feedback} />
    </div>
  );
}
