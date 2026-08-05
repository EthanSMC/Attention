"use client";

import { useMemo, useState } from "react";

interface OAuthConnection {
  clientId: string;
  clientName: string;
  createdAt: string;
  scopes: string[];
}

interface PatConnection {
  createdAt: string;
  expiresAt: string | null;
  id: string;
  keyPrefix: string;
  name: string;
  status: "active" | "revoked";
}

interface ChannelConnection {
  appId: string;
  boundAt: string;
  id: string;
  provider: string;
  revokedAt: string | null;
}

export function ConnectionManager({
  channels,
  isMember,
  mcpUrl,
  oauthConnections,
  pats,
  skillUrl,
}: {
  channels: ChannelConnection[];
  isMember: boolean;
  mcpUrl: string;
  oauthConnections: OAuthConnection[];
  pats: PatConnection[];
  skillUrl: string;
}) {
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const activeClients = useMemo(() => {
    const seen = new Set<string>();
    return oauthConnections.filter((item) => {
      if (seen.has(item.clientId)) return false;
      seen.add(item.clientId);
      return true;
    });
  }, [oauthConnections]);
  const codexCommand = `codex mcp add attention --url ${mcpUrl}`;
  const claudeCommand = `claude mcp add --transport http --scope user attention ${mcpUrl}`;

  async function copy(value: string) {
    await navigator.clipboard.writeText(value);
    setMessage("已复制。");
  }

  async function createApiKey() {
    setBusy(true);
    setCreatedKey(null);
    setMessage(null);
    const response = await fetch("/api/account/pats", {
      body: JSON.stringify({
        expires_in_days: 90,
        name: "Attention API Key",
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const result = (await response.json().catch(() => ({}))) as { key?: string };
    setBusy(false);
    if (response.ok && result.key) setCreatedKey(result.key);
    else setMessage("API Key 没有创建，请重试。");
  }

  async function revokePat(id: string) {
    const response = await fetch(`/api/account/pats/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (response.ok) window.location.reload();
    else setMessage("撤销没有完成，请重试。");
  }

  async function revokeOAuth(clientId: string) {
    const response = await fetch(`/api/account/oauth/${encodeURIComponent(clientId)}`, { method: "DELETE" });
    if (response.ok) window.location.reload();
    else setMessage("撤销没有完成，请重试。");
  }

  async function revokeChannel(identityId: string) {
    const response = await fetch(`/api/account/channels/${encodeURIComponent(identityId)}`, {
      method: "DELETE",
    });
    if (response.ok) window.location.reload();
    else setMessage("解绑没有完成，请重试。");
  }

  return (
    <div className="connection-stack">
      <section className="connection-card connection-card--hero">
        <p className="settings-card__eyebrow">推荐：OAuth + PKCE</p>
        <h2>把 Attention 加到你的 Agent</h2>
        <p>添加远程 MCP 后，在客户端触发登录。浏览器会显示 scope 和当前账号，允许后自动返回客户端。</p>
        <div className="install-command"><div><strong>Codex</strong><code>{codexCommand}</code></div><button onClick={() => copy(codexCommand)} type="button">复制</button></div>
        <div className="install-command"><div><strong>Claude Code</strong><code>{claudeCommand}</code></div><button onClick={() => copy(claudeCommand)} type="button">复制</button></div>
        <div className="install-command"><div><strong>公开 Skill</strong><code>{skillUrl}</code></div><button onClick={() => copy(skillUrl)} type="button">复制</button></div>
        <p className="connection-note">连接能力始终跟随当前账号；升级或降级后，同一连接会立即获得对应能力，无需重新授权。</p>
      </section>

      <section className="connection-card">
        <p className="settings-card__eyebrow">已授权客户端</p>
        <h2>OAuth 连接</h2>
        {activeClients.length ? <ul className="credential-list">{activeClients.map((item) => <li key={item.clientId}><div><strong>{item.clientName}</strong><span>{item.scopes.join(" · ")}</span></div><button onClick={() => revokeOAuth(item.clientId)} type="button">撤销</button></li>)}</ul> : <p>还没有 OAuth 客户端连接。</p>}
      </section>

      <section className="connection-card">
        <p className="settings-card__eyebrow">API Key</p>
        <h2>密钥连接</h2>
        <p>客户端不支持浏览器 OAuth 时使用。所有 Key 类型相同，实际能力跟随账号实时变化；原文只显示一次，网站只保存哈希与前缀。</p>
        <div className="button-row"><button className="button button--secondary" disabled={busy} onClick={createApiKey} type="button">创建 API Key</button></div>
        {createdKey ? <div className="one-time-secret"><strong>只显示一次</strong><code>{createdKey}</code><button onClick={() => copy(createdKey)} type="button">复制密钥</button></div> : null}
        {pats.some((item) => item.status === "active") ? <ul className="credential-list">{pats.filter((item) => item.status === "active").map((item) => <li key={item.id}><div><strong>{item.name}</strong><span>{item.keyPrefix}… · {item.expiresAt ? `到期 ${new Date(item.expiresAt).toLocaleDateString("zh-CN")}` : "不过期"}</span></div><button onClick={() => revokePat(item.id)} type="button">撤销</button></li>)}</ul> : null}
      </section>

      <section className="connection-card">
        <p className="settings-card__eyebrow">Hosted Channel</p>
        <h2>微信与企业微信</h2>
        {channels.filter((item) => !item.revokedAt).length ? <ul className="credential-list">{channels.filter((item) => !item.revokedAt).map((item) => <li key={item.id}><div><strong>{item.provider}</strong><span>应用 {item.appId} · 已明确绑定</span></div><button onClick={() => revokeChannel(item.id)} type="button">解绑</button></li>)}</ul> : <p>{isMember ? "从公众号或企业微信发送第一条消息后，使用一次性链接绑定。" : "Hosted Channel 是 Member 能力；升级后可从消息入口发起绑定。"}</p>}
      </section>
      {message ? <p aria-live="polite" className="connection-toast">{message}</p> : null}
    </div>
  );
}
