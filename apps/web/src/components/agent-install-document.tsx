"use client";

import type { AgentConnectionProjection } from "../server/agent-connection-projection";
import { AgentDocNavigation, type AgentDocumentLink } from "./agent-doc-navigation";
import { TransientFeedback, useTransientFeedback } from "./transient-feedback";

export function AgentInstallDocument({
  agentLinks,
  capabilityManifestUrl,
  capabilityToolCount,
  connection,
}: {
  agentLinks: readonly AgentDocumentLink[];
  capabilityManifestUrl: string;
  capabilityToolCount: number;
  connection: AgentConnectionProjection;
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
      <AgentDocNavigation activeAgentId={connection.id} agentLinks={agentLinks} />

      <article className="agent-doc-document">
        <header className="agent-doc-hero">
          <p>Agent 接入文档</p>
          <h1>{connection.displayName}</h1>
          <div className="agent-doc-status">
            <span className={`agent-status-badge agent-status-badge--${connection.status.tone}`}>
              {connection.status.label}
            </span>
            {connection.minimumVersion ? (
              <span>最低版本 {connection.minimumVersion}</span>
            ) : null}
          </div>
          <p>{connection.status.detail}</p>
        </header>

        <section className="agent-doc-section" id="before-you-start">
          <p className="agent-doc-section__eyebrow">开始之前</p>
          <h2>连接由 Skill、MCP 和 OAuth 组成</h2>
          <p>
            Skill 告诉 {connection.displayName} 何时以及怎样使用 Attention；MCP
            提供可调用的业务工具；OAuth 在浏览器中把连接授权给你的 Attention
            账号。账号权益和 OAuth scope 会共同决定实际可见的工具子集。
          </p>
          <div aria-label="连接路径" className="agent-doc-path">
            <span>{connection.displayName}</span>
            <span aria-hidden="true">→</span>
            <span>Attention Skill</span>
            <span aria-hidden="true">→</span>
            <span>Attention MCP</span>
          </div>
        </section>

        <section className="agent-doc-section" id="skill">
          <p className="agent-doc-section__eyebrow">步骤 1</p>
          <h2>加载统一的 Attention Skill</h2>
          <p>
            所有宿主使用同一份 Attention Skill。先查看统一 Skill 文档，再按本页给出的宿主命令或图形界面步骤导入。
          </p>
          <a className="agent-doc-inline-link" href="/doc/skill">查看 Attention Skill 文档 <span aria-hidden="true">↗</span></a>
          <div className="agent-doc-host-note">
            <strong>本页只说明 {connection.displayName} 的加载方式。</strong>
            <span>Skill 内容、版本和验收规则不因宿主变化。</span>
          </div>
          <div className="agent-resource-list">
            {connection.skillPathLabel && connection.skillPaths.length ? (
              <div className="agent-resource-row agent-resource-row--paths">
                <div>
                  <span>{connection.skillPathLabel}</span>
                  {connection.skillPaths.map((path) => (
                    <code key={`${path.label}-${path.value}`}><b>{path.label}</b>{path.value}</code>
                  ))}
                </div>
                <div className="agent-resource-actions">
                  {connection.skillPaths.map((path) => (
                    <button key={path.label} onClick={() => copy(path.value, `${path.label} 路径`)} type="button">
                      复制{path.label === "所有平台" ? "路径" : path.label}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>

          {connection.manualChecklist.length ? (
            <div className="agent-manual-checklist">
              <div className="agent-section-heading"><h3>图形界面安装步骤</h3><span>按顺序完成</span></div>
              <ol>
                {connection.manualChecklist.map((step) => (
                  <li key={step.title}>
                    <div><strong>{step.title}</strong><p>{step.detail}</p>{step.value ? <code>{step.value}</code> : null}</div>
                    {step.value ? <button onClick={() => copy(step.value!, step.title)} type="button">复制</button> : null}
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
        </section>

        <section className="agent-doc-section" id="mcp">
          <p className="agent-doc-section__eyebrow">步骤 2</p>
          <h2>添加 MCP 并完成 OAuth</h2>
          <p>
            添加 MCP 后，宿主会打开 Attention 的授权页面。请在浏览器中登录并确认授权；不要把 OAuth token
            复制回 Agent。若宿主不支持浏览器 OAuth，才使用设置页中的 API Key 作为备用方案。
          </p>
          <div className="agent-resource-list">
            <div className="agent-resource-row">
              <div><span>MCP 地址</span><code>{connection.mcpUrl}</code></div>
              <button onClick={() => copy(connection.mcpUrl, "MCP 地址")} type="button">复制</button>
            </div>
            <div className="agent-resource-row">
              <div><span>能力目录</span><code>{capabilityToolCount} 个业务工具 · 实际能力随授权和账号权益变化</code></div>
              <div className="agent-resource-actions">
                <a href={capabilityManifestUrl} rel="noreferrer" target="_blank">查看机器清单</a>
                <button onClick={() => copy(capabilityManifestUrl, "能力清单地址")} type="button">复制地址</button>
              </div>
            </div>
          </div>

          {connection.commands.length ? (
            <div className="agent-command-list">
              <div className="agent-section-heading"><h3>宿主命令</h3><span>在本机运行；不会执行远端脚本</span></div>
              {connection.commands.map((command) => (
                <div className="agent-command-row" key={`${connection.id}-${command.label}-${command.platform}`}>
                  <div>
                    <span>{command.label}{command.platform === "all" ? "" : ` · ${command.platform === "posix" ? "macOS / Linux" : "Windows"}`}</span>
                    <code>{command.value}</code>
                    {command.kind === "configuration_probe" ? <small>仅查看本地配置不代表工具已经可用。</small> : null}
                  </div>
                  <button onClick={() => copy(command.value, command.label)} type="button">复制</button>
                </div>
              ))}
            </div>
          ) : (
            <p className="agent-manual-setup-note">该宿主需要在图形界面中使用上面的 Skill 和 MCP 地址完成配置。</p>
          )}
        </section>

        {connection.channelSetup ? (
          <section className="agent-doc-section" id="channel">
            <p className="agent-doc-section__eyebrow">
              {connection.channelSetup.command ? "步骤 3" : "微信接入"}
            </p>
            <h2>微信接入</h2>
            <p>{connection.channelSetup.detail}</p>
            {connection.channelSetup.command ? (
              <div className="agent-resource-list">
                <div className="agent-resource-row">
                  <div>
                    <span>启动本机桥</span>
                    <code>{connection.channelSetup.command}</code>
                  </div>
                  <button
                    onClick={() =>
                      copy(connection.channelSetup?.command ?? "", "启动桥命令")
                    }
                    type="button"
                  >
                    复制
                  </button>
                </div>
              </div>
            ) : null}
            {connection.channelSetup.prerequisites.length ? (
              <ul className="agent-doc-prerequisites">
                {connection.channelSetup.prerequisites.map((prerequisite) => (
                  <li key={prerequisite}>{prerequisite}</li>
                ))}
              </ul>
            ) : null}
            <p className="agent-manual-setup-note">
              首次启动会显示二维码，用手机微信扫码一次即可；凭据只保存在本机，Attention
              不显示也不验证微信连接状态。
            </p>
          </section>
        ) : null}

        <section className="agent-doc-section" id="verify">
          <p className="agent-doc-section__eyebrow">
            {connection.channelSetup ? "步骤 4" : "步骤 3"}
          </p>
          <h2>用真实工具调用验收</h2>
          <div className="agent-acceptance-step">
            <div><span>在 Agent 中调用</span><code>{connection.acceptance.toolName}</code></div>
            <p>{connection.acceptance.detail}</p>
          </div>
        </section>

        <footer className="agent-doc-sources">
          <span>宿主官方资料</span>
          <div>
            {connection.sources.map((source) => (
              <a href={source.url} key={source.url} rel="noreferrer" target="_blank">{source.label}<span aria-hidden="true">↗</span></a>
            ))}
          </div>
        </footer>
      </article>
      <TransientFeedback feedback={feedback} />
    </div>
  );
}
