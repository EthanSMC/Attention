"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

export interface GrowthRewardsData {
  consumerInvite: {
    canCreate: boolean;
    expiresAt: string | null;
    registeredAt: string | null;
    status: "active" | "expired" | "invalidated" | "redeemed" | "unavailable";
  };
  filterCodes: Array<{
    createdAt: string;
    expiresAt: string;
    id: string;
    issuanceYear: number;
    redeemedAt: string | null;
    status: "active" | "expired" | "invalidated" | "issuer_revoked" | "redeemed";
  }>;
  filterCodesIssuedThisYear: number;
  isFilter: boolean;
  pointsBalances: Array<{
    availableMinor: number;
    clawbackMinor: number;
    currency: string;
    reservedMinor: number;
  }>;
  pointsEntries: Array<{
    amountMinor: number;
    currency: string;
    entryType: "consume" | "earn" | "release" | "reserve" | "reversal";
    id: string;
    occurredAt: string;
  }>;
}

const entryLabels: Record<GrowthRewardsData["pointsEntries"][number]["entryType"], string> = {
  consume: "用于续费",
  earn: "续费奖励",
  release: "释放预留",
  reserve: "预留续费",
  reversal: "退款／拒付冲正",
};

async function responseError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as {
    error?: { code?: string };
  };
  switch (body.error?.code) {
    case "active_consumer_invite_exists":
      return "已有仍有效的链接；如需替换，请使用重新签发。";
    case "consumer_invite_ineligible":
    case "consumer_invite_used":
      return "当前账号已不能创建新的 Consumer 邀请。";
    case "filter_code_annual_limit":
      return "本 UTC 自然年的 5 张累计签发额度已用完。";
    case "filter_code_invalid":
      return "兑换码无效、已过期、已兑换，或签发 Filter 已失效。";
    case "filter_required":
      return "只有当前有效 Filter 可以签发年卡。";
    case "rate_limited":
      return "尝试过于频繁，请一小时后再试。";
    default:
      return "操作没有完成，请稍后重试。";
  }
}

export function GrowthRewards({ data }: { data: GrowthRewardsData }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [consumerLink, setConsumerLink] = useState<string | null>(null);
  const [filterCode, setFilterCode] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function createInvitation(replaceActive: boolean) {
    setBusy("invite");
    setMessage(null);
    const response = await fetch("/api/account/growth/invitations", {
      body: JSON.stringify({ replace_active: replaceActive }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    if (!response.ok) {
      setMessage(await responseError(response));
      setBusy(null);
      return;
    }
    const result = (await response.json()) as { join_path: string };
    setConsumerLink(`${window.location.origin}${result.join_path}`);
    setMessage("邀请链接已创建；原文只在这里显示，请立即保存。重新签发会使旧链接失效。");
    setBusy(null);
    router.refresh();
  }

  async function issueCode() {
    setBusy("issue");
    setMessage(null);
    const response = await fetch("/api/account/growth/filter-codes", {
      body: "{}",
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    if (!response.ok) {
      setMessage(await responseError(response));
      setBusy(null);
      return;
    }
    const result = (await response.json()) as { token: string };
    setFilterCode(result.token);
    setMessage("年卡兑换码已签发；原文只显示一次，请立即保存。过期或撤销不返还年度额度。");
    setBusy(null);
    router.refresh();
  }

  async function redeemCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy("redeem");
    setMessage(null);
    const response = await fetch("/api/account/growth/filter-codes/redeem", {
      body: JSON.stringify({ token: String(form.get("token") ?? "").trim() }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    if (!response.ok) {
      setMessage(await responseError(response));
      setBusy(null);
      return;
    }
    setMessage("兑换成功，12 个日历月 Member 已按现有权益尾部顺延。刷新后权益立即生效。");
    setBusy(null);
    event.currentTarget.reset();
    router.refresh();
  }

  return (
    <div className="growth-rewards">
      {message ? <p aria-live="polite" className="receipt receipt--neutral">{message}</p> : null}
      <section className="settings-card">
        <p className="settings-card__eyebrow">Consumer 邀请</p>
        <h2>一生一个成功邀请名额</h2>
        <p>仅尚未注册的新邮箱可使用。成功注册后双方各获 3 个日历月 Member，已有权益自动顺延。</p>
        <p>当前状态：{data.consumerInvite.status}</p>
        {consumerLink ? <output className="credential-secret">{consumerLink}</output> : null}
        {data.consumerInvite.canCreate ? (
          <button
            className="button button--secondary"
            disabled={busy !== null}
            onClick={() => createInvitation(data.consumerInvite.status === "active")}
            type="button"
          >
            {data.consumerInvite.status === "active" ? "重新签发并使旧链接失效" : "创建邀请链接"}
          </button>
        ) : (
          <p>Filter 或已经成功邀请过一人的账号不能再创建 Consumer 邀请。</p>
        )}
      </section>

      <section className="settings-card">
        <p className="settings-card__eyebrow">Filter 年卡</p>
        <h2>兑换 12 个日历月 Member</h2>
        <form className="settings-form" onSubmit={redeemCode}>
          <label>
            兑换码
            <input autoComplete="off" minLength={32} name="token" required type="text" />
          </label>
          <button className="button button--secondary" disabled={busy !== null} type="submit">
            {busy === "redeem" ? "兑换中…" : "兑换年卡"}
          </button>
        </form>
        {data.isFilter ? (
          <div>
            <p>本 UTC 自然年已累计签发 {data.filterCodesIssuedThisYear}/5 张。</p>
            {filterCode ? <output className="credential-secret">{filterCode}</output> : null}
            <button
              className="button button--secondary"
              disabled={busy !== null || data.filterCodesIssuedThisYear >= 5}
              onClick={issueCode}
              type="button"
            >
              {busy === "issue" ? "签发中…" : "签发一张年卡"}
            </button>
          </div>
        ) : null}
        {data.filterCodes.length > 0 ? (
          <ul className="credential-list">
            {data.filterCodes.map((code) => (
              <li key={code.id}>
                <div>
                  <strong>{code.issuanceYear} · {code.status}</strong>
                  <span>签发 {new Date(code.createdAt).toLocaleDateString("zh-CN")} · 到期 {new Date(code.expiresAt).toLocaleDateString("zh-CN")}</span>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="settings-card">
        <p className="settings-card__eyebrow">续费积分</p>
        <h2>余额与不可变记录</h2>
        <p>积分按币种隔离，只能用于未来续费；退款或拒付会按原结算事件冲正。</p>
        {data.pointsBalances.length === 0 ? (
          <p>当前没有积分。</p>
        ) : (
          <ul className="credential-list">
            {data.pointsBalances.map((balance) => (
              <li key={balance.currency}>
                <div>
                  <strong>{balance.currency} 可用 {balance.availableMinor} 最小货币单位</strong>
                  <span>已预留 {balance.reservedMinor} · 待追偿 {balance.clawbackMinor}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
        {data.pointsEntries.length > 0 ? (
          <ul className="credential-list">
            {data.pointsEntries.map((entry) => (
              <li key={entry.id}>
                <div>
                  <strong>{entryLabels[entry.entryType]} · {entry.amountMinor} {entry.currency}</strong>
                  <span>{new Date(entry.occurredAt).toLocaleString("zh-CN")}</span>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}
