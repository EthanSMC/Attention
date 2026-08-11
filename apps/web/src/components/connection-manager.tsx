"use client";

import {
  type FormEvent,
  useCallback,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";

import { ApiKeyCreateModal } from "./api-key-create-modal";
import { TransientFeedback, useTransientFeedback } from "./transient-feedback";
import {
  apiKeyManagerReducer,
  type ApiKeyRow,
  createApiKeyManagerState,
} from "./api-key-manager-state";

interface OAuthConnection {
  clientId: string;
  clientName: string;
  createdAt: string;
  scopes: string[];
}

interface LocalChannelRuntime {
  deviceName: string;
  hostName: string;
  lastSeenAt: string | null;
  lastSuccessfulMessageAt: string | null;
  pendingInbound: number;
  pendingOutbound: number;
  status: "degraded" | "offline" | "online" | "stale";
}

type PatConnection = ApiKeyRow;

function formatAccountDate(value: string): string {
  return new Date(value).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" });
}

function formatAccountDateTime(value: string): string {
  return new Date(value).toLocaleString("zh-CN", {
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    timeZone: "Asia/Shanghai",
  });
}

const runtimeStatusLabels: Record<LocalChannelRuntime["status"], string> = {
  degraded: "需要处理",
  offline: "离线",
  online: "在线",
  stale: "久未在线",
};

export function ConnectionManager({
  agentConnectionPrompt,
  agentDocumentationUrl,
  localChannelRuntimes,
  oauthConnections,
  pats,
}: {
  agentConnectionPrompt: string;
  agentDocumentationUrl: string;
  localChannelRuntimes: LocalChannelRuntime[];
  oauthConnections: OAuthConnection[];
  pats: PatConnection[];
}) {
  const [apiKeys, dispatchApiKey] = useReducer(
    apiKeyManagerReducer,
    pats,
    createApiKeyManagerState,
  );
  const { clearFeedback, feedback, showFeedback } = useTransientFeedback();
  const [revokingPatId, setRevokingPatId] = useState<string | null>(null);
  const createRequestInFlight = useRef(false);
  const revokeRequestInFlight = useRef(false);
  const activeClients = useMemo(() => {
    const seen = new Set<string>();
    return oauthConnections.filter((item) => {
      if (seen.has(item.clientId)) return false;
      seen.add(item.clientId);
      return true;
    });
  }, [oauthConnections]);
  const activePats = apiKeys.rows.filter((item) => item.status === "active");

  async function copy(value: string, label = "内容") {
    try {
      await navigator.clipboard.writeText(value);
      showFeedback(`${label}已复制。`);
    } catch {
      showFeedback("复制失败，请重试。", "error");
    }
  }

  const closeApiKeyModal = useCallback(() => {
    if (createRequestInFlight.current) return;
    dispatchApiKey({ type: "close" });
    if (apiKeys.uncertain) window.location.reload();
  }, [apiKeys.uncertain]);

  async function createApiKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (createRequestInFlight.current) return;
    const name = apiKeys.name.trim();
    if (!name) {
      dispatchApiKey({ message: "请先填写一个名称。", type: "create_failed" });
      return;
    }

    createRequestInFlight.current = true;
    dispatchApiKey({ type: "create_started" });
    try {
      const response = await fetch("/api/account/pats", {
        body: JSON.stringify({
          expires_in_days: 90,
          name,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const result = (await response.json().catch(() => ({}))) as {
        credential_id?: string;
        expires_at?: string | null;
        key?: string;
        key_prefix?: string;
        name?: string;
      };
      if (
        !response.ok ||
        !result.credential_id ||
        !result.key ||
        !result.key_prefix ||
        !result.name
      ) {
        dispatchApiKey({
          message: "API Key 没有创建，请重试。",
          type: "create_failed",
        });
        return;
      }
      dispatchApiKey({
        row: {
          createdAt: new Date().toISOString(),
          expiresAt: result.expires_at ?? null,
          id: result.credential_id,
          keyPrefix: result.key_prefix,
          lastUsedAt: null,
          name: result.name,
          needsRotation: false,
          status: "active",
        },
        secret: result.key,
        type: "create_succeeded",
      });
    } catch {
      dispatchApiKey({
        message: "网络中断，创建结果无法确认。请关闭窗口并刷新页面检查；如果出现同名 Key，请先撤销再重试。",
        type: "create_unknown",
      });
    } finally {
      createRequestInFlight.current = false;
    }
  }

  async function revokePat(id: string) {
    if (revokeRequestInFlight.current) return;
    revokeRequestInFlight.current = true;
    setRevokingPatId(id);
    clearFeedback();
    try {
      const response = await fetch(`/api/account/pats/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      const result = (await response.json().catch(() => ({}))) as { revoked?: boolean };
      if (response.ok && result.revoked) {
        dispatchApiKey({ id, type: "revoke_succeeded" });
        showFeedback("API Key 已撤销。");
      } else {
        showFeedback("撤销没有完成，请重试。", "error");
      }
    } catch {
      showFeedback("网络连接失败，撤销没有完成。请重试。", "error");
    } finally {
      revokeRequestInFlight.current = false;
      setRevokingPatId(null);
    }
  }

  async function revokeOAuth(clientId: string) {
    const response = await fetch(`/api/account/oauth/${encodeURIComponent(clientId)}`, { method: "DELETE" });
    if (response.ok) window.location.reload();
    else showFeedback("撤销没有完成，请重试。", "error");
  }

  return (
    <div className="connection-stack">
      <section className="connection-card connection-card--agent-entry">
        <div>
          <p className="settings-card__eyebrow">本地 Agent</p>
          <h2>让你的 AI 完成接入</h2>
          <p>
            复制一段提示词给你正在使用的 AI。它会识别宿主，打开对应文档，并完成 Skill、MCP
            和 OAuth 配置。
          </p>
        </div>
        <div className="agent-entry-actions">
          <button
            className="button button--primary"
            onClick={() => copy(agentConnectionPrompt, "接入提示词")}
            type="button"
          >
            复制给 AI
          </button>
          <a
            className="button button--secondary"
            href={agentDocumentationUrl}
            rel="noreferrer"
            target="_blank"
          >
            查看接入文档 <span aria-hidden="true">↗</span>
          </a>
        </div>
      </section>

      {localChannelRuntimes.length ? (
        <section className="connection-card connection-card--runtime">
          <div className="connection-card__intro">
            <p className="settings-card__eyebrow">本地 Channel</p>
            <h2>设备运行状态</h2>
            <p>这里只显示设备运行与队列状态，不显示对话、链接或本地凭据。</p>
          </div>
          <ul className="channel-runtime-list">
            {localChannelRuntimes.map((runtime, index) => (
              <li key={`${runtime.deviceName}-${runtime.hostName}-${index}`}>
                <div className="channel-runtime-list__identity">
                  <strong>{runtime.deviceName}</strong>
                  <span>{runtime.hostName}</span>
                </div>
                <span
                  className={`channel-runtime-status channel-runtime-status--${runtime.status}`}
                >
                  <span aria-hidden="true" />
                  {runtimeStatusLabels[runtime.status]}
                </span>
                <dl className="channel-runtime-facts">
                  <div>
                    <dt>最后在线</dt>
                    <dd>
                      {runtime.lastSeenAt
                        ? formatAccountDateTime(runtime.lastSeenAt)
                        : "暂无心跳"}
                    </dd>
                  </div>
                  <div>
                    <dt>上次完成</dt>
                    <dd>
                      {runtime.lastSuccessfulMessageAt
                        ? formatAccountDateTime(runtime.lastSuccessfulMessageAt)
                        : "尚无记录"}
                    </dd>
                  </div>
                  <div>
                    <dt>队列</dt>
                    <dd>
                      待处理 {runtime.pendingInbound} · 待回执 {runtime.pendingOutbound}
                    </dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="connection-card">
        <p className="settings-card__eyebrow">已授权客户端</p>
        <h2>OAuth 连接</h2>
        {activeClients.length ? <ul className="credential-list">{activeClients.map((item) => <li key={item.clientId}><div><strong>{item.clientName}</strong><span>{item.scopes.join(" · ")}</span></div><button onClick={() => revokeOAuth(item.clientId)} type="button">撤销</button></li>)}</ul> : <p>还没有 OAuth 客户端连接。</p>}
      </section>

      <section className="connection-card">
        <p className="settings-card__eyebrow">API Key</p>
        <h2>密钥连接</h2>
        <p>
          客户端不支持浏览器 OAuth 时使用。新建 Key 会包含当前完整权限范围，账号权益会实时决定可用能力；旧 Key 仍以创建时的权限范围为上限，标记为“需轮换”时需要新建，才能使用后来增加的能力。原文只显示一次，网站只保存哈希与前缀。
        </p>
        <div className="button-row">
          <button
            aria-haspopup="dialog"
            className="button button--secondary"
            onClick={() => dispatchApiKey({ type: "open" })}
            type="button"
          >
            创建 API Key
          </button>
        </div>
        {activePats.length ? (
          <div
            aria-label="API Key 表格，可横向滚动"
            className="api-key-table-wrap"
            role="region"
            tabIndex={0}
          >
            <table className="api-key-table">
              <caption className="sr-only">当前有效的 API Key</caption>
              <thead>
                <tr>
                  <th scope="col">名称</th>
                  <th scope="col">密钥</th>
                  <th scope="col">权限范围</th>
                  <th scope="col">有效期</th>
                  <th className="api-key-table__last-used" scope="col">最近使用</th>
                  <th className="api-key-table__action" scope="col"><span className="sr-only">操作</span></th>
                </tr>
              </thead>
              <tbody>
                {activePats.map((item) => (
                  <tr key={item.id}>
                    <td><strong>{item.name}</strong></td>
                    <td><code>{item.keyPrefix}…</code></td>
                    <td>
                      <span
                        className={`api-key-scope-status api-key-scope-status--${item.needsRotation ? "rotate" : "current"}`}
                        title={item.needsRotation ? "这枚 Key 缺少后来新增的权限。请新建 Key，并在客户端替换后撤销旧 Key。" : "这枚 Key 包含当前全部 API Key 权限。"}
                      >
                        <span aria-hidden="true" />
                        {item.needsRotation ? "需轮换" : "当前完整"}
                      </span>
                    </td>
                    <td>{item.expiresAt ? formatAccountDate(item.expiresAt) : "不过期"}</td>
                    <td className="api-key-table__last-used">{item.lastUsedAt ? formatAccountDate(item.lastUsedAt) : "未使用"}</td>
                    <td className="api-key-table__action">
                      <button
                        disabled={revokingPatId !== null}
                        onClick={() => revokePat(item.id)}
                        type="button"
                      >
                        {revokingPatId === item.id ? "撤销中…" : "撤销"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <TransientFeedback feedback={feedback} />
      {apiKeys.modal !== "closed" ? (
        <ApiKeyCreateModal
          busy={apiKeys.busy}
          error={apiKeys.error}
          name={apiKeys.name}
          onCancel={closeApiKeyModal}
          onCreate={createApiKey}
          onFinish={closeApiKeyModal}
          onNameChange={(value) => dispatchApiKey({ type: "change_name", value })}
          retryBlocked={apiKeys.uncertain}
          secret={apiKeys.secret}
          stage={apiKeys.modal}
        />
      ) : null}
    </div>
  );
}
