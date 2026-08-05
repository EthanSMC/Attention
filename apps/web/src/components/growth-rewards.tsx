"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";

export interface GrowthRewardsData {
  consumerInvite: {
    canCreate: boolean;
    expiresAt: string | null;
    quota: number;
    registeredAt: string | null;
    status: "active" | "expired" | "invalidated" | "redeemed" | "unavailable";
    successfulCount: number;
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

const consumerInviteStatusLabels: Record<
  GrowthRewardsData["consumerInvite"]["status"],
  string
> = {
  active: "可用",
  expired: "已过期",
  invalidated: "已失效",
  redeemed: "已使用",
  unavailable: "暂无资格",
};

const filterCodeStatusLabels: Record<
  GrowthRewardsData["filterCodes"][number]["status"],
  string
> = {
  active: "有效",
  expired: "已过期",
  invalidated: "已失效",
  issuer_revoked: "签发方已撤销",
  redeemed: "已兑换",
};

function formatMinorCurrency(amountMinor: number, currency: string): string {
  try {
    const formatter = new Intl.NumberFormat("zh-CN", {
      currency,
      style: "currency",
    });
    const fractionDigits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
    return formatter.format(amountMinor / 10 ** fractionDigits);
  } catch {
    return `${amountMinor} ${currency}`;
  }
}

async function responseError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as {
    error?: { code?: string };
  };
  switch (body.error?.code) {
    case "active_consumer_invite_exists":
      return "已有仍有效的链接；如需替换，请使用重新签发。";
    case "consumer_invite_used":
      return "邀请名额已用完。";
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
  const messageTimer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (messageTimer.current !== null) window.clearTimeout(messageTimer.current);
    };
  }, []);

  function clearMessage() {
    if (messageTimer.current !== null) {
      window.clearTimeout(messageTimer.current);
      messageTimer.current = null;
    }
    setMessage(null);
  }

  function showMessage(nextMessage: string) {
    if (messageTimer.current !== null) window.clearTimeout(messageTimer.current);
    setMessage(nextMessage);
    messageTimer.current = window.setTimeout(() => {
      setMessage(null);
      messageTimer.current = null;
    }, 2_800);
  }

  async function createInvitation(replaceActive: boolean) {
    setBusy("invite");
    clearMessage();
    const response = await fetch("/api/account/growth/invitations", {
      body: JSON.stringify({ replace_active: replaceActive }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    if (!response.ok) {
      showMessage(await responseError(response));
      setBusy(null);
      return;
    }
    const result = (await response.json()) as { join_path: string };
    setConsumerLink(`${window.location.origin}${result.join_path}`);
    showMessage("邀请链接已创建；原文只在这里显示，请立即保存。重新签发会使旧链接失效。");
    setBusy(null);
    router.refresh();
  }

  async function copyConsumerLink() {
    if (!consumerLink) return;
    try {
      await navigator.clipboard.writeText(consumerLink);
      showMessage("邀请链接已复制。可以直接发送给新用户。");
    } catch {
      showMessage("复制失败，请手动保存邀请链接。");
    }
  }

  async function issueCode() {
    setBusy("issue");
    clearMessage();
    const response = await fetch("/api/account/growth/filter-codes", {
      body: "{}",
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    if (!response.ok) {
      showMessage(await responseError(response));
      setBusy(null);
      return;
    }
    const result = (await response.json()) as { token: string };
    setFilterCode(result.token);
    showMessage("年卡兑换码已签发；原文只显示一次，请立即保存。过期或撤销不返还年度额度。");
    setBusy(null);
    router.refresh();
  }

  async function redeemCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy("redeem");
    clearMessage();
    const response = await fetch("/api/account/growth/filter-codes/redeem", {
      body: JSON.stringify({ token: String(form.get("token") ?? "").trim() }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    if (!response.ok) {
      showMessage(await responseError(response));
      setBusy(null);
      return;
    }
    showMessage("兑换成功，12 个日历月 Member 已按现有权益尾部顺延。刷新后权益立即生效。");
    setBusy(null);
    event.currentTarget.reset();
    router.refresh();
  }

  return (
    <div className="growth-rewards">
      {message ? <div aria-live="polite" className="growth-rewards__toast" role="status">{message}</div> : null}
      <section className="settings-card growth-rewards__section">
        <p className="settings-card__eyebrow">新用户邀请</p>
        <h2>邀请新用户，双方各得 3 个月 Member</h2>
        <p>仅对尚未注册 Attention 的新邮箱有效。成功注册后，双方各得 3 个月 Member，已有权益自动顺延。</p>
        <p className="growth-rewards__quota">
          <span>邀请名额</span>
          <strong>{data.consumerInvite.successfulCount} / {data.consumerInvite.quota}</strong>
        </p>
        <p>状态：{consumerInviteStatusLabels[data.consumerInvite.status]}</p>
        {data.consumerInvite.canCreate ? (
          <div className="growth-rewards__invite-actions">
            {consumerLink ? (
              <button
                aria-label="复制新用户邀请链接"
                className="credential-secret growth-rewards__copy-link"
                onClick={copyConsumerLink}
                type="button"
              >
                {consumerLink}
              </button>
            ) : <span aria-hidden="true" />}
            <button
              className="button button--secondary"
              disabled={busy !== null}
              onClick={() => createInvitation(data.consumerInvite.status === "active")}
              type="button"
            >
              {data.consumerInvite.status === "active" ? "刷新并使旧链接失效" : "创建邀请链接"}
            </button>
          </div>
        ) : (
          <p>邀请名额已用完。</p>
        )}
      </section>

      {!data.isFilter ? (
        <section className="settings-card growth-rewards__section">
          <p className="settings-card__eyebrow">Member 权益</p>
          <h2>兑换 Member 年卡</h2>
          <p>有兑换码？粘贴后获得 12 个日历月 Member。</p>
          <form className="settings-form growth-rewards__redeem-form" onSubmit={redeemCode}>
            <input
              aria-label="兑换码"
              autoComplete="off"
              minLength={32}
              name="token"
              required
              type="text"
            />
            <button className="button button--secondary" disabled={busy !== null} type="submit">
              {busy === "redeem" ? "兑换中…" : "兑换 Member 年卡"}
            </button>
          </form>
        </section>
      ) : null}

      {data.isFilter ? (
        <section className="settings-card growth-rewards__section">
          <p className="settings-card__eyebrow">Filter 权益</p>
          <h2>签发 Member 年卡</h2>
          <p>把年卡兑换码发给需要延长 Member 权益的人。每个 UTC 自然年最多签发 5 张。</p>
          <div className="growth-rewards__issuance-actions">
            <p className="growth-rewards__quota">
              <span>本 UTC 自然年已签发</span>
              <strong>{data.filterCodesIssuedThisYear} / 5 张</strong>
            </p>
            <button
              className="button button--secondary"
              disabled={busy !== null || data.filterCodesIssuedThisYear >= 5}
              onClick={issueCode}
              type="button"
            >
              {busy === "issue" ? "签发中…" : "签发 Member 年卡"}
            </button>
          </div>
          {filterCode ? <output className="credential-secret">{filterCode}</output> : null}
          {data.filterCodes.length > 0 ? (
            <ul className="credential-list">
              {data.filterCodes.map((code) => (
                <li key={code.id}>
                  <div>
                    <strong>{code.issuanceYear} · {filterCodeStatusLabels[code.status]}</strong>
                    <span>签发 {new Date(code.createdAt).toLocaleDateString("zh-CN")} · 到期 {new Date(code.expiresAt).toLocaleDateString("zh-CN")}</span>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      <section className="settings-card growth-rewards__section">
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
                  <strong>可用 {formatMinorCurrency(balance.availableMinor, balance.currency)}</strong>
                  <span>
                    已预留 {formatMinorCurrency(balance.reservedMinor, balance.currency)} · 待追偿 {formatMinorCurrency(balance.clawbackMinor, balance.currency)}
                  </span>
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
                  <strong>{entryLabels[entry.entryType]} · {formatMinorCurrency(entry.amountMinor, entry.currency)}</strong>
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
