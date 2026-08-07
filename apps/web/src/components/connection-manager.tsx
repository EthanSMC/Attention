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
import {
  apiKeyManagerReducer,
  type ApiKeyRow,
  createApiKeyManagerState,
} from "./api-key-manager-state";
import type { AgentConnectionProjection } from "../server/agent-connection-projection";

interface OAuthConnection {
  clientId: string;
  clientName: string;
  createdAt: string;
  scopes: string[];
}

type PatConnection = ApiKeyRow;

function formatAccountDate(value: string): string {
  return new Date(value).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" });
}

export function ConnectionManager({
  agentConnections,
  capabilityManifestUrl,
  capabilityToolCount,
  oauthConnections,
  pats,
}: {
  agentConnections: readonly AgentConnectionProjection[];
  capabilityManifestUrl: string;
  capabilityToolCount: number;
  oauthConnections: OAuthConnection[];
  pats: PatConnection[];
}) {
  const [apiKeys, dispatchApiKey] = useReducer(
    apiKeyManagerReducer,
    pats,
    createApiKeyManagerState,
  );
  const [message, setMessage] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState(
    agentConnections[0]?.id ?? "openclaw",
  );
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
  const selectedAgent =
    agentConnections.find((agent) => agent.id === selectedAgentId) ??
    agentConnections[0];
  const activePats = apiKeys.rows.filter((item) => item.status === "active");

  async function copy(value: string, label = "内容") {
    await navigator.clipboard.writeText(value);
    setMessage(`${label}已复制。`);
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
    setMessage(null);
    try {
      const response = await fetch(`/api/account/pats/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      const result = (await response.json().catch(() => ({}))) as { revoked?: boolean };
      if (response.ok && result.revoked) {
        dispatchApiKey({ id, type: "revoke_succeeded" });
        setMessage("API Key 已撤销。");
      } else {
        setMessage("撤销没有完成，请重试。");
      }
    } catch {
      setMessage("网络连接失败，撤销没有完成。请重试。");
    } finally {
      revokeRequestInFlight.current = false;
      setRevokingPatId(null);
    }
  }

  async function revokeOAuth(clientId: string) {
    const response = await fetch(`/api/account/oauth/${encodeURIComponent(clientId)}`, { method: "DELETE" });
    if (response.ok) window.location.reload();
    else setMessage("撤销没有完成，请重试。");
  }

  return (
    <div className="connection-stack">
      <section className="connection-card connection-card--agents">
        <div className="agent-setup-intro">
          <div>
            <p className="settings-card__eyebrow">本地 Agent</p>
            <h2>选择你正在使用的 Agent</h2>
          </div>
          <p>
            Skill 负责告诉 Agent 怎样使用 Attention，MCP 负责登录与执行操作。配置由你的 Agent 宿主管理。
          </p>
        </div>

        <div className="agent-setup-layout">
          <div
            aria-label="选择 Agent"
            className="agent-setup-picker"
            role="group"
          >
            {agentConnections.map((agent) => (
              <button
                aria-controls={`agent-setup-${agent.id}`}
                aria-pressed={agent.id === selectedAgent?.id}
                className="agent-setup-picker__item"
                id={`agent-selector-${agent.id}`}
                key={agent.id}
                onClick={() => setSelectedAgentId(agent.id)}
                type="button"
              >
                <span className="agent-setup-picker__mark" aria-hidden="true">
                  {agent.displayName.slice(0, 1)}
                </span>
                <span className="agent-setup-picker__copy">
                  <strong>{agent.displayName}</strong>
                  <small>{agent.status.label}</small>
                </span>
              </button>
            ))}
          </div>

          {selectedAgent ? (
            <div
              aria-labelledby={`agent-selector-${selectedAgent.id}`}
              className="agent-setup-detail"
              id={`agent-setup-${selectedAgent.id}`}
              role="region"
            >
              <div className="agent-setup-detail__heading">
                <div>
                  <p className="agent-setup-detail__kicker">当前配置</p>
                  <h3>{selectedAgent.displayName}</h3>
                </div>
                <div className="agent-status-group">
                  <span
                    className={`agent-status-badge agent-status-badge--${selectedAgent.status.tone}`}
                  >
                    {selectedAgent.status.label}
                  </span>
                  {selectedAgent.minimumVersion ? (
                    <span className="agent-minimum-version">
                      最低版本 {selectedAgent.minimumVersion}
                    </span>
                  ) : null}
                </div>
              </div>
              <p className="agent-setup-detail__summary">
                {selectedAgent.status.detail}
              </p>

              <div aria-label="连接路径" className="agent-setup-path">
                <span>{selectedAgent.displayName}</span>
                <span aria-hidden="true">→</span>
                <span>Attention MCP</span>
              </div>

              <div className="agent-resource-list">
                {selectedAgent.skillUrl ? (
                  <div className="agent-resource-row">
                    <div>
                      <span>{selectedAgent.skillLabel}</span>
                      <code>{selectedAgent.skillUrl}</code>
                    </div>
                    <div className="agent-resource-actions">
                      {selectedAgent.skillDownloadFilename ? (
                        <a
                          download={selectedAgent.skillDownloadFilename}
                          href={selectedAgent.skillUrl}
                        >
                          下载
                        </a>
                      ) : null}
                      <button
                        onClick={() => copy(selectedAgent.skillUrl!, selectedAgent.skillLabel)}
                        type="button"
                      >
                        复制地址
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="agent-resource-row agent-resource-row--unavailable">
                    <div>
                      <span>{selectedAgent.skillLabel}</span>
                      <strong>尚未发布</strong>
                    </div>
                  </div>
                )}
                {selectedAgent.skillPathLabel && selectedAgent.skillPaths.length ? (
                  <div className="agent-resource-row agent-resource-row--paths">
                    <div>
                      <span>{selectedAgent.skillPathLabel}</span>
                      {selectedAgent.skillPaths.map((path) => (
                        <code key={`${path.label}-${path.value}`}>
                          <b>{path.label}</b>
                          {path.value}
                        </code>
                      ))}
                    </div>
                    <div className="agent-resource-actions">
                      {selectedAgent.skillPaths.map((path) => (
                        <button
                          key={path.label}
                          onClick={() => copy(path.value, `${path.label} 路径`)}
                          type="button"
                        >
                          复制{path.label === "所有平台" ? "路径" : path.label}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
                {selectedAgent.skillSha256 ? (
                  <div className="agent-resource-row agent-resource-row--digest">
                    <div>
                      <span>SHA-256</span>
                      <code>{selectedAgent.skillSha256}</code>
                    </div>
                    <button
                      onClick={() => copy(selectedAgent.skillSha256!, "SHA-256")}
                      type="button"
                    >
                      复制
                    </button>
                  </div>
                ) : null}
                <div className="agent-resource-row">
                  <div>
                    <span>MCP 地址</span>
                    <code>{selectedAgent.mcpUrl}</code>
                  </div>
                  <button
                    onClick={() => copy(selectedAgent.mcpUrl, "MCP 地址")}
                    type="button"
                  >
                    复制
                  </button>
                </div>
                <div className="agent-resource-row">
                  <div>
                    <span>能力范围</span>
                    <code>{capabilityToolCount} 个业务工具 · 权限随账号权益实时变化</code>
                  </div>
                  <div className="agent-resource-actions">
                    <a
                      href={capabilityManifestUrl}
                      rel="noreferrer"
                      target="_blank"
                    >
                      查看机器清单
                    </a>
                    <button
                      onClick={() => copy(capabilityManifestUrl, "能力清单地址")}
                      type="button"
                    >
                      复制地址
                    </button>
                  </div>
                </div>
              </div>

              {selectedAgent.manualChecklist.length ? (
                <div className="agent-manual-checklist">
                  <div className="agent-section-heading">
                    <h4>WorkBuddy 安装步骤</h4>
                    <span>按顺序完成</span>
                  </div>
                  <ol>
                    {selectedAgent.manualChecklist.map((step) => (
                      <li key={step.title}>
                        <div>
                          <strong>{step.title}</strong>
                          <p>{step.detail}</p>
                          {step.value ? <code>{step.value}</code> : null}
                        </div>
                        {step.value ? (
                          <button
                            onClick={() => copy(step.value!, step.title)}
                            type="button"
                          >
                            复制
                          </button>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                </div>
              ) : null}

              {selectedAgent.commands.length ? (
                <div className="agent-command-list">
                  <div className="agent-section-heading">
                    <h4>下载与宿主配置</h4>
                    <span>在本机终端运行；不会执行远端脚本</span>
                  </div>
                  {selectedAgent.commands.map((command) => (
                    <div className="agent-command-row" key={`${selectedAgent.id}-${command.label}`}>
                      <div>
                        <span>{command.label}</span>
                        <code>{command.value}</code>
                        {command.kind === "configuration_probe" ? (
                          <small>仅查看或检查宿主配置，不代表 Attention 工具已经可用。</small>
                        ) : null}
                      </div>
                      <button
                        onClick={() => copy(command.value, command.label)}
                        type="button"
                      >
                        复制
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="agent-manual-setup-note">
                  该宿主暂不提供可验证的命令行配置，请复制上方地址并在宿主设置中手动添加。
                </p>
              )}

              <div className="agent-acceptance-step">
                <div>
                  <span>最终验收</span>
                  <strong>在 Agent 中调用</strong>
                  <code>{selectedAgent.acceptance.toolName}</code>
                </div>
                <p>{selectedAgent.acceptance.detail}</p>
              </div>

              <div className="agent-source-links">
                <span>官方资料</span>
                <div>
                  {selectedAgent.sources.map((source) => (
                    <a
                      href={source.url}
                      key={source.url}
                      rel="noreferrer"
                      target="_blank"
                    >
                      {source.label}
                      <span aria-hidden="true">↗</span>
                    </a>
                  ))}
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </section>

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

      {message ? <p aria-live="polite" className="connection-toast">{message}</p> : null}
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
