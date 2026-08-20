"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { BotIcon, LinkIcon } from "./icons";
import { TransientFeedback, useTransientFeedback } from "./transient-feedback";

type AgentConnectionStatus = "connected" | "not_connected" | "signed_out";
type BridgeConnectionStatus =
  | "needs_attention"
  | "not_configured"
  | "online"
  | "signed_out";
type AgentWechatBindingStatus =
  | "bound"
  | "not_bound"
  | "pending"
  | "signed_out";

const wechatStatusCopy: Record<
  AgentWechatBindingStatus,
  { detail: string; label: string }
> = {
  bound: {
    detail: "已检测到本地 Agent 的微信绑定，消息仍由你的本地 Agent 接收和处理。",
    label: "已绑定",
  },
  not_bound: {
    detail: "还没有检测到微信绑定。完成本地 Agent 配置并扫码后，状态会显示在这里。",
    label: "未绑定",
  },
  pending: {
    detail: "已收到本地 Agent 的绑定报告，等待完成微信扫码确认。",
    label: "等待确认",
  },
  signed_out: {
    detail: "登录 Attention 后，可以查看本地 Agent 的微信绑定状态。",
    label: "登录后查看",
  },
};

type AgentPathTone = "missing" | "ready" | "unknown" | "warning";

interface AgentPathNode {
  id: "agent" | "attention" | "bridge" | "wechat";
  label: string;
  status: string;
  tone: AgentPathTone;
}

interface AgentPathLink {
  action: string | null;
  id: "agent-bridge" | "attention-agent" | "bridge-wechat";
  label: string;
  tone: AgentPathTone;
}

export function AgentPageContent({
  agentConnectionStatus,
  agentDocumentationUrl,
  agentConnectionPrompt,
  bridgeConnectionStatus,
  supportedAgents,
  wechatBindingStatus,
}: {
  agentConnectionStatus: AgentConnectionStatus;
  agentDocumentationUrl: string;
  agentConnectionPrompt: string;
  bridgeConnectionStatus: BridgeConnectionStatus;
  supportedAgents: readonly string[];
  wechatBindingStatus: AgentWechatBindingStatus;
}) {
  const { feedback, showFeedback } = useTransientFeedback();
  const [copyDialogOpen, setCopyDialogOpen] = useState(false);
  const wechatStatus = wechatStatusCopy[wechatBindingStatus];
  const signedOut = agentConnectionStatus === "signed_out";

  const pathNodes: AgentPathNode[] = [
    {
      id: "attention",
      label: "Attention",
      status: signedOut ? "未登录" : "已就绪",
      tone: signedOut ? "unknown" : "ready",
    },
    {
      id: "agent",
      label: "本地 Agent",
      status:
        agentConnectionStatus === "connected"
          ? "已连接"
          : signedOut
            ? "待检测"
            : "未连接",
      tone:
        agentConnectionStatus === "connected"
          ? "ready"
          : signedOut
            ? "unknown"
            : "missing",
    },
    {
      id: "bridge",
      label: "本地 Bridge",
      status:
        bridgeConnectionStatus === "online"
          ? "在线"
          : bridgeConnectionStatus === "needs_attention"
            ? "需检查"
            : bridgeConnectionStatus === "signed_out"
              ? "待检测"
              : "未配置",
      tone:
        bridgeConnectionStatus === "online"
          ? "ready"
          : bridgeConnectionStatus === "needs_attention"
            ? "warning"
            : bridgeConnectionStatus === "signed_out"
              ? "unknown"
              : "missing",
    },
    {
      id: "wechat",
      label: "微信",
      status: wechatStatus.label,
      tone:
        wechatBindingStatus === "bound"
          ? "ready"
          : wechatBindingStatus === "pending"
            ? "warning"
            : wechatBindingStatus === "signed_out"
              ? "unknown"
              : "missing",
    },
  ];

  const pathLinks: AgentPathLink[] = [
    {
      action: signedOut
        ? null
        : agentConnectionStatus === "connected"
          ? null
          : "连接 Agent",
      id: "attention-agent",
      label:
        agentConnectionStatus === "connected"
          ? "已连接"
          : signedOut
            ? "登录后检测"
            : "尚未连接",
      tone:
        agentConnectionStatus === "connected"
          ? "ready"
          : signedOut
            ? "unknown"
            : "missing",
    },
    {
      action:
        bridgeConnectionStatus === "online" || signedOut
          ? null
          : bridgeConnectionStatus === "needs_attention"
            ? "检查 Bridge"
            : "配置 Bridge",
      id: "agent-bridge",
      label:
        bridgeConnectionStatus === "online"
          ? "运行中"
          : bridgeConnectionStatus === "needs_attention"
            ? "连接异常"
            : signedOut
              ? "登录后检测"
              : "尚未配置",
      tone:
        bridgeConnectionStatus === "online"
          ? "ready"
          : bridgeConnectionStatus === "needs_attention"
            ? "warning"
            : signedOut
              ? "unknown"
              : "missing",
    },
    {
      action:
        wechatBindingStatus === "bound" || signedOut
          ? null
          : wechatBindingStatus === "pending"
            ? "继续绑定"
            : "绑定微信",
      id: "bridge-wechat",
      label:
        wechatBindingStatus === "bound"
          ? "已连通"
          : wechatBindingStatus === "pending"
            ? "等待确认"
            : signedOut
              ? "登录后检测"
              : "尚未绑定",
      tone:
        wechatBindingStatus === "bound"
          ? "ready"
          : wechatBindingStatus === "pending"
            ? "warning"
            : signedOut
              ? "unknown"
              : "missing",
    },
  ];

  useEffect(() => {
    if (!copyDialogOpen) return;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setCopyDialogOpen(false);
    }
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [copyDialogOpen]);

  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(agentConnectionPrompt);
      setCopyDialogOpen(true);
    } catch {
      showFeedback("复制失败，请重试。", "error");
    }
  }

  return (
    <div className="agent-page__content">
      <section aria-labelledby="local-agent-title" className="agent-page__local">
        <div className="agent-page__local-main">
          <div className="agent-page__card-heading">
            <span aria-hidden="true" className="agent-page__card-mark">
              <BotIcon />
            </span>
            <div>
              <p className="agent-page__eyebrow">本地 Agent</p>
              <h2 id="local-agent-title">让你的 AI 完成接入</h2>
            </div>
          </div>
          <p className="agent-page__card-description">
            复制一段提示词给你正在使用的 AI。它会识别宿主，打开对应文档，并完成 Skill、MCP
            和 OAuth 配置。
          </p>

          <div className="agent-page__actions">
            <button className="button button--primary" onClick={copyPrompt} type="button">
              一键连接本地Agent
            </button>
            <Link className="button button--secondary" href={agentDocumentationUrl}>
              查看手动接入文档 <span aria-hidden="true">↗</span>
            </Link>
          </div>
        </div>

        <aside className="agent-page__local-aside">
          <p className="agent-page__aside-label">当前支持</p>
          <ul>
            {supportedAgents.map((agent) => (
              <li key={agent}>
                <span aria-hidden="true" />
                {agent}
              </li>
            ))}
          </ul>
          <p className="agent-page__aside-note">
            配置由你的 AI 在本机完成。OAuth 授权会在浏览器中确认，凭据不会写入提示词。
          </p>
        </aside>

        <div className="agent-page__path-block">
          <div className="agent-page__path-heading">
            <div>
              <p className="agent-page__eyebrow">本地连接链路</p>
              <h3>Attention 到微信</h3>
            </div>
            <p>双向表示消息与结果往返；断点可直接配置。</p>
          </div>
          <div
            aria-label="Attention、本地 Agent、本地 Bridge 和微信的双向连接状态"
            className="agent-path"
            role="list"
          >
            {pathNodes.map((node, index) => {
              const link = pathLinks[index];

              return (
                <div
                  className={`agent-path__node agent-path__node--${node.tone}`}
                  key={node.id}
                  role="listitem"
                >
                  <span aria-hidden="true" className="agent-path__mark">
                    {node.id === "attention" ? (
                      <span className="signal-logo">
                        <span className="signal-logo__human" />
                        <span className="signal-logo__ai" />
                      </span>
                    ) : node.id === "agent" ? (
                      <BotIcon />
                    ) : node.id === "bridge" ? (
                      <LinkIcon />
                    ) : (
                      "微"
                    )}
                  </span>
                  <strong>{node.label}</strong>
                  <small>{node.status}</small>
                  {link ? (
                    <div
                      className={`agent-path__connector agent-path__connector--${link.tone}`}
                    >
                      <span aria-hidden="true" className="agent-path__line" />
                      {link.action ? (
                        <button onClick={copyPrompt} type="button">
                          {link.action}
                        </button>
                      ) : (
                        <small>{link.label}</small>
                      )}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <section aria-labelledby="cloud-agent-title" className="agent-page__cloud">
        <span aria-hidden="true" className="agent-page__cloud-mark">
          <BotIcon />
        </span>
        <div className="agent-page__cloud-copy">
          <p className="agent-page__eyebrow">云端 Agent</p>
          <h2 id="cloud-agent-title">在 Attention 里直接使用</h2>
          <p>云端 Agent 正在开发中。完成后，你可以不安装本地运行时，直接在 Attention 里使用。</p>
        </div>
        <span className="agent-page__status">开发中</span>
      </section>

      {copyDialogOpen ? (
        <div className="agent-copy-modal">
          <button
            aria-label="关闭提示"
            className="agent-copy-modal__backdrop"
            onClick={() => setCopyDialogOpen(false)}
            tabIndex={-1}
            type="button"
          />
          <section
            aria-labelledby="agent-copy-dialog-title"
            aria-modal="true"
            className="agent-copy-modal__dialog"
            role="dialog"
          >
            <span aria-hidden="true" className="agent-copy-modal__mark">✓</span>
            <p className="agent-page__eyebrow">提示词已复制</p>
            <h2 id="agent-copy-dialog-title">请发送给你的本地Agent</h2>
            <p>把刚才复制的内容粘贴并发送给本地 Agent，它会检查断开的环节并继续引导你完成接入。</p>
            <button
              autoFocus
              className="button button--primary"
              onClick={() => setCopyDialogOpen(false)}
              type="button"
            >
              我知道了
            </button>
          </section>
        </div>
      ) : null}

      <TransientFeedback feedback={feedback} />
    </div>
  );
}
