"use client";

import {
  type FormEvent,
  useCallback,
  useReducer,
  useRef,
  useState,
} from "react";
import type { OAuthAudience, OAuthScope } from "@attention/auth";

import { buildOAuthConsentPresentation } from "../lib/oauth-consent-presentation";
import { ApiKeyCreateModal } from "./api-key-create-modal";
import { TransientFeedback, useTransientFeedback } from "./transient-feedback";
import {
  apiKeyManagerReducer,
  type ApiKeyRow,
  createApiKeyManagerState,
} from "./api-key-manager-state";

interface AgentOAuthConnection {
  deviceName: string | null;
  id: string;
  label: string;
  lastAuthorizedAt: string;
  lastUsedAt: string | null;
  scopes: OAuthScope[];
}

interface AgentOAuthConnectionGroup {
  audience: OAuthAudience;
  clientName: string;
  connections: AgentOAuthConnection[];
}

interface OAuthConnectionRenameState {
  busy: boolean;
  connectionId: string;
  error: string | null;
  value: string;
}

type OAuthGroupRevokeOutcome = "failed" | "revoked" | "stale" | "unknown";
type OAuthConnectionRenameOutcome = "conflict" | "failed" | "renamed" | "unknown";

export async function requestOAuthConnectionRename(
  connectionId: string,
  label: string,
  request: typeof fetch = fetch,
): Promise<OAuthConnectionRenameOutcome> {
  try {
    const response = await request(
      `/api/account/oauth/${encodeURIComponent(connectionId)}`,
      {
        body: JSON.stringify({ label }),
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      },
    );
    if (response.status === 409) return "conflict";
    if (!response.ok) return "failed";
    const result = (await response.json().catch(() => ({}))) as {
      label?: unknown;
      renamed?: unknown;
    };
    return typeof result.label === "string" && typeof result.renamed === "boolean"
      ? "renamed"
      : "failed";
  } catch {
    return "unknown";
  }
}

export function applyOAuthConnectionRename(
  groups: readonly AgentOAuthConnectionGroup[],
  connectionId: string,
  label: string,
): AgentOAuthConnectionGroup[] {
  return groups.map((group) => ({
    ...group,
    connections: group.connections.map((connection) =>
      connection.id === connectionId ? { ...connection, label } : connection
    ),
  }));
}

export async function requestOAuthGroupSnapshotRevoke(
  group: AgentOAuthConnectionGroup,
  request: typeof fetch = fetch,
): Promise<OAuthGroupRevokeOutcome> {
  const connectionIds = group.connections.map(({ id }) => id);
  try {
    const response = await request("/api/account/oauth/group", {
      body: JSON.stringify({
        audience: group.audience,
        client_name: group.clientName,
        connection_ids: connectionIds,
      }),
      headers: { "Content-Type": "application/json" },
      method: "DELETE",
    });
    if (response.status === 409) return "stale";
    const result = (await response.json().catch(() => ({}))) as {
      revoked_count?: number;
    };
    return response.ok && result.revoked_count === connectionIds.length
      ? "revoked"
      : "failed";
  } catch {
    return "unknown";
  }
}

export function oauthGroupRevokeFailureMessage(
  outcome: OAuthGroupRevokeOutcome,
): string {
  if (outcome === "stale") return "连接列表已变化，请刷新后重试。";
  if (outcome === "unknown") {
    return "网络连接中断，撤销结果无法确认。请刷新连接列表后再操作。";
  }
  return "批量撤销没有完成，请刷新页面后重试。";
}

interface LocalChannelRuntime {
  adapterVersion: string;
  deviceName: string;
  hostName: string;
  lastSeenAt: string | null;
  lastSuccessfulMessageAt: string | null;
  pendingInbound: number;
  pendingOutbound: number;
  status: "degraded" | "offline" | "online" | "stale";
  version: {
    latestVersion: string;
    status: "current" | "manual" | "recommended" | "required" | "unknown";
  };
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

const oauthAudienceLabels: Record<OAuthAudience, string> = {
  "attention-channel-runtime": "本地 Runtime",
  "attention-mcp": "Agent",
  "attention-sync": "同步",
};

function oauthPermissionTitles(
  audience: OAuthAudience,
  scopes: readonly OAuthScope[],
): string[] {
  try {
    return buildOAuthConsentPresentation(audience, scopes).permissionGroups.map(
      ({ title }) => title,
    );
  } catch {
    return ["权限信息暂时不可用"];
  }
}

export function OAuthConnectionRenameEditor({
  busy,
  error,
  label,
  onCancel,
  onChange,
  onSubmit,
}: {
  busy: boolean;
  error: string | null;
  label: string;
  onCancel: () => void;
  onChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <form className="oauth-connection-rename" onSubmit={onSubmit}>
      <label>
        <span>连接名称</span>
        <input
          autoFocus
          disabled={busy}
          maxLength={80}
          onChange={(event) => onChange(event.target.value)}
          value={label}
        />
      </label>
      {error ? <p role="alert">{error}</p> : null}
      <div>
        <button className="button button--primary" disabled={busy} type="submit">
          {busy ? "保存中…" : "保存"}
        </button>
        <button
          className="button button--secondary"
          disabled={busy}
          onClick={onCancel}
          type="button"
        >
          取消
        </button>
      </div>
    </form>
  );
}

const bridgeVersionStatusLabels: Record<
  LocalChannelRuntime["version"]["status"],
  string
> = {
  current: "已是最新",
  manual: "需手动确认升级",
  recommended: "建议更新",
  required: "需要更新",
  unknown: "版本状态未知",
};

export function OAuthGroupRevokeModal({
  busy,
  clientName,
  connectionCount,
  onCancel,
  onConfirm,
}: {
  busy: boolean;
  clientName: string;
  connectionCount: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      aria-labelledby="oauth-group-revoke-title"
      aria-modal="true"
      className="collect-modal oauth-group-revoke-modal"
      role="dialog"
    >
      <button
        aria-label="关闭撤销确认"
        className="collect-modal__backdrop"
        disabled={busy}
        onClick={onCancel}
        tabIndex={-1}
        type="button"
      />
      <section className="collect-modal__sheet oauth-group-revoke-modal__sheet">
        <header className="collect-modal__heading">
          <div>
            <p className="eyebrow">OAuth / MCP</p>
            <h2 id="oauth-group-revoke-title">
              撤销 {clientName} 的 {connectionCount} 个连接？
            </h2>
          </div>
          <button
            aria-label="关闭"
            className="collect-modal__close"
            disabled={busy}
            onClick={onCancel}
            type="button"
          >
            ×
          </button>
        </header>
        <p>
          这 {connectionCount} 个连接会立即停止访问 Attention。连接名称会重新可用，之后仍可再次授权。
        </p>
        <div className="oauth-group-revoke-modal__actions">
          <button
            className="button button--secondary"
            disabled={busy}
            onClick={onCancel}
            type="button"
          >
            取消
          </button>
          <button
            className="button button--danger"
            disabled={busy}
            onClick={onConfirm}
            type="button"
          >
            {busy ? "正在撤销…" : `撤销全部 ${connectionCount} 个连接`}
          </button>
        </div>
      </section>
    </div>
  );
}

export function ConnectionManager({
  agentOAuthConnections,
  localChannelRuntimes,
  pats,
}: {
  agentOAuthConnections: AgentOAuthConnectionGroup[];
  localChannelRuntimes: LocalChannelRuntime[];
  pats: PatConnection[];
}) {
  const [apiKeys, dispatchApiKey] = useReducer(
    apiKeyManagerReducer,
    pats,
    createApiKeyManagerState,
  );
  const { clearFeedback, feedback, showFeedback } = useTransientFeedback();
  const [revokingPatId, setRevokingPatId] = useState<string | null>(null);
  const [revokingOAuthConnectionId, setRevokingOAuthConnectionId] = useState<
    string | null
  >(null);
  const [oauthGroupToRevoke, setOAuthGroupToRevoke] = useState<
    AgentOAuthConnectionGroup | null
  >(null);
  const [revokingOAuthGroup, setRevokingOAuthGroup] = useState(false);
  const [oauthConnectionGroups, setOAuthConnectionGroups] = useState(
    agentOAuthConnections,
  );
  const [oauthRename, setOAuthRename] = useState<OAuthConnectionRenameState | null>(null);
  const createRequestInFlight = useRef(false);
  const renameRequestInFlight = useRef(false);
  const revokeRequestInFlight = useRef(false);
  const renameButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const activePats = apiKeys.rows.filter((item) => item.status === "active");

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

  async function revokeOAuthConnection(connectionId: string) {
    if (revokeRequestInFlight.current) return;
    revokeRequestInFlight.current = true;
    setRevokingOAuthConnectionId(connectionId);
    clearFeedback();
    try {
      const response = await fetch(
        `/api/account/oauth/${encodeURIComponent(connectionId)}`,
        { method: "DELETE" },
      );
      if (response.ok) window.location.reload();
      else showFeedback("撤销没有完成，请重试。", "error");
    } catch {
      showFeedback("网络连接失败，撤销没有完成。请重试。", "error");
    } finally {
      revokeRequestInFlight.current = false;
      setRevokingOAuthConnectionId(null);
    }
  }

  async function revokeOAuthGroup(group: AgentOAuthConnectionGroup) {
    if (revokeRequestInFlight.current) return;
    revokeRequestInFlight.current = true;
    setRevokingOAuthGroup(true);
    clearFeedback();
    try {
      const outcome = await requestOAuthGroupSnapshotRevoke(group);
      if (outcome === "revoked") {
        window.location.reload();
      } else {
        showFeedback(oauthGroupRevokeFailureMessage(outcome), "error");
      }
    } catch {
      showFeedback(oauthGroupRevokeFailureMessage("unknown"), "error");
    } finally {
      revokeRequestInFlight.current = false;
      setRevokingOAuthGroup(false);
    }
  }

  function finishOAuthRename(connectionId: string) {
    setOAuthRename(null);
    queueMicrotask(() => renameButtonRefs.current.get(connectionId)?.focus());
  }

  async function saveOAuthRename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!oauthRename || renameRequestInFlight.current) return;
    const value = oauthRename.value;
    if (!value.trim()) {
      setOAuthRename({ ...oauthRename, error: "请输入连接名称。" });
      return;
    }

    renameRequestInFlight.current = true;
    setOAuthRename({ ...oauthRename, busy: true, error: null });
    const connectionId = oauthRename.connectionId;
    const outcome = await requestOAuthConnectionRename(connectionId, value);
    if (outcome === "renamed") {
      const normalizedLabel = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
      setOAuthConnectionGroups((groups) =>
        applyOAuthConnectionRename(groups, connectionId, normalizedLabel)
      );
      showFeedback("连接名称已更新。");
      finishOAuthRename(connectionId);
    } else {
      const error = outcome === "conflict"
        ? "这个名称已被同类连接使用，请换一个名称。"
        : outcome === "unknown"
          ? "网络连接中断，修改结果无法确认。请刷新页面检查。"
          : "名称没有更新，请重试。";
      setOAuthRename((current) =>
        current?.connectionId === connectionId
          ? { ...current, busy: false, error }
          : current
      );
    }
    renameRequestInFlight.current = false;
  }

  return (
    <div className="connection-stack">
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
                  <div>
                    <dt>Bridge</dt>
                    <dd>
                      {runtime.adapterVersion} · {bridgeVersionStatusLabels[runtime.version.status]}
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
        <p>每个名称代表一次独立授权。展开客户端后，可以查看权限与最近活动，或只撤销其中一个连接。</p>
        {oauthConnectionGroups.length ? (
          <div className="oauth-connection-groups">
            {oauthConnectionGroups.map((group) => (
              <details
                className="oauth-connection-group"
                key={`${group.audience}:${group.clientName}`}
              >
                <summary>
                  <strong>
                    {group.clientName} · {group.connections.length} 个连接
                    <small> · {oauthAudienceLabels[group.audience]}</small>
                  </strong>
                  <span aria-hidden="true">⌄</span>
                </summary>
                <div className="oauth-connection-group__body">
                  <div className="oauth-connection-group__toolbar">
                    <span>按连接名称分别管理，不按客户端注册合并。</span>
                    <button
                      onClick={() => setOAuthGroupToRevoke(group)}
                      type="button"
                    >
                      撤销全部
                    </button>
                  </div>
                  <ul className="oauth-connection-list">
                    {group.connections.map((connection) => (
                      <li key={connection.id}>
                        {oauthRename?.connectionId === connection.id ? (
                          <OAuthConnectionRenameEditor
                            busy={oauthRename.busy}
                            error={oauthRename.error}
                            label={oauthRename.value}
                            onCancel={() => finishOAuthRename(connection.id)}
                            onChange={(value) => setOAuthRename({
                              ...oauthRename,
                              error: null,
                              value,
                            })}
                            onSubmit={saveOAuthRename}
                          />
                        ) : (
                          <div className="oauth-connection-list__heading">
                            <strong>{connection.label}</strong>
                            <div>
                              <button
                                aria-label={`重命名连接：${connection.label}`}
                                className="oauth-connection-action oauth-connection-action--rename"
                                disabled={oauthRename !== null}
                                onClick={() => setOAuthRename({
                                  busy: false,
                                  connectionId: connection.id,
                                  error: null,
                                  value: connection.label,
                                })}
                                ref={(node) => {
                                  if (node) renameButtonRefs.current.set(connection.id, node);
                                  else renameButtonRefs.current.delete(connection.id);
                                }}
                                type="button"
                              >
                                重命名
                              </button>
                              <button
                                aria-label={`撤销连接：${connection.label}`}
                                className="oauth-connection-action oauth-connection-action--revoke"
                                disabled={revokingOAuthConnectionId !== null}
                                onClick={() => revokeOAuthConnection(connection.id)}
                                type="button"
                              >
                                {revokingOAuthConnectionId === connection.id
                                  ? "撤销中…"
                                  : "撤销"}
                              </button>
                            </div>
                          </div>
                        )}
                        <dl className="oauth-connection-facts">
                          {connection.deviceName ? (
                            <div>
                              <dt>可信设备</dt>
                              <dd>{connection.deviceName}</dd>
                            </div>
                          ) : null}
                          <div>
                            <dt>最近授权</dt>
                            <dd>{formatAccountDateTime(connection.lastAuthorizedAt)}</dd>
                          </div>
                          <div>
                            <dt>最近使用</dt>
                            <dd>
                              {connection.lastUsedAt
                                ? formatAccountDateTime(connection.lastUsedAt)
                                : "尚未使用"}
                            </dd>
                          </div>
                        </dl>
                        <div className="oauth-scope-disclosure">
                          <strong>权限</strong>
                          <ul>
                            {oauthPermissionTitles(
                              group.audience,
                              connection.scopes,
                            ).map((title) => (
                              <li key={title}>{title}</li>
                            ))}
                          </ul>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              </details>
            ))}
          </div>
        ) : (
          <p>还没有 OAuth 客户端连接。</p>
        )}
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
      {oauthGroupToRevoke ? (
        <OAuthGroupRevokeModal
          busy={revokingOAuthGroup}
          clientName={oauthGroupToRevoke.clientName}
          connectionCount={oauthGroupToRevoke.connections.length}
          onCancel={() => {
            if (!revokingOAuthGroup) setOAuthGroupToRevoke(null);
          }}
          onConfirm={() => revokeOAuthGroup(oauthGroupToRevoke)}
        />
      ) : null}
    </div>
  );
}
