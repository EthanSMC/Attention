"use client";

import { useState, type FormEvent } from "react";

import { ArrowUpRightIcon } from "./icons";

const ATTENTION_ID_COOLDOWN_MS = 365 * 24 * 60 * 60 * 1000;

type AttentionIdMessage = {
  text: string;
  tone: "error" | "success";
};

type AccountMembership = {
  hasMemberEntitlement: boolean;
  subscription: {
    cancelAtPeriodEnd: boolean;
    currentPeriodEndLabel: string;
    status: "trialing" | "active" | "past_due" | "cancelled" | "expired";
  } | null;
};

const subscriptionStatusLabels: Record<
  NonNullable<AccountMembership["subscription"]>["status"],
  string
> = {
  active: "订阅中",
  cancelled: "已取消",
  expired: "已到期",
  past_due: "待处理",
  trialing: "试用中",
};

function nextAttentionIdChange(
  changedAt: Date | string | null,
): string | null {
  if (!changedAt) return null;
  const changedAtMs = new Date(changedAt).getTime();
  if (!Number.isFinite(changedAtMs)) return null;
  return new Date(changedAtMs + ATTENTION_ID_COOLDOWN_MS).toISOString();
}

function formatAttentionIdDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    day: "numeric",
    month: "long",
    timeZone: "Asia/Shanghai",
    year: "numeric",
  }).format(date);
}

export function AccountSettingsForm({
  attentionId: initialAttentionId,
  attentionIdChangedAt,
  displayName,
  membership,
}: {
  attentionId: string | null;
  attentionIdChangedAt: Date | string | null;
  displayName: string;
  membership: AccountMembership;
}) {
  const [attentionId, setAttentionId] = useState(initialAttentionId);
  const [attentionIdDraft, setAttentionIdDraft] = useState(
    initialAttentionId ?? "",
  );
  const [attentionIdMessage, setAttentionIdMessage] =
    useState<AttentionIdMessage | null>(null);
  const [attentionIdNextChangeAt, setAttentionIdNextChangeAt] = useState(() =>
    initialAttentionId
      ? nextAttentionIdChange(attentionIdChangedAt)
      : null,
  );
  const [profileMessage, setProfileMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<"attention-id" | "profile" | null>(null);
  const attentionIdLocked = Boolean(
    attentionId &&
      attentionIdNextChangeAt &&
      new Date(attentionIdNextChangeAt).getTime() > Date.now(),
  );

  async function saveAttentionId(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = attentionIdDraft.trim().toLowerCase();
    setAttentionIdDraft(value);
    setBusy("attention-id");
    setAttentionIdMessage(null);

    try {
      const response = await fetch("/api/account/attention-id", {
        body: JSON.stringify({ attention_id: value }),
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      });
      const result = (await response.json().catch(() => ({}))) as {
        attention_id?: string;
        error?: { code?: string; next_change_at?: string | null };
        next_change_at?: string | null;
      };

      if (response.ok) {
        const savedAttentionId = result.attention_id ?? value;
        const nextChangeAt =
          result.next_change_at ?? nextAttentionIdChange(new Date());
        setAttentionId(savedAttentionId);
        setAttentionIdDraft(savedAttentionId);
        setAttentionIdNextChangeAt(nextChangeAt);
        setAttentionIdMessage({
          text: "Attention ID 已保存。",
          tone: "success",
        });
        return;
      }

      const errorCode = result.error?.code;
      const errorNextChangeAt =
        result.next_change_at ?? result.error?.next_change_at ?? null;
      if (errorCode === "invalid_attention_id") {
        setAttentionIdMessage({
          text: "请输入符合下方规则的 Attention ID。",
          tone: "error",
        });
      } else if (errorCode === "attention_id_taken") {
        setAttentionIdMessage({
          text: "这个 Attention ID 已被使用，请换一个。",
          tone: "error",
        });
      } else if (errorCode === "attention_id_cooldown") {
        if (errorNextChangeAt) {
          setAttentionIdNextChangeAt(errorNextChangeAt);
        }
        setAttentionIdDraft(attentionId ?? attentionIdDraft);
        setAttentionIdMessage({
          text: errorNextChangeAt
            ? `暂时不能修改。下次可在 ${formatAttentionIdDate(errorNextChangeAt)} 修改。`
            : "Attention ID 每 365 天只能修改一次，请稍后再试。",
          tone: "error",
        });
      } else if (errorCode === "recent_authentication_required") {
        setAttentionIdMessage({
          text: "修改前需要重新验证身份。请退出后使用邮箱验证码登录，再回来修改。",
          tone: "error",
        });
      } else {
        setAttentionIdMessage({
          text: "Attention ID 没有保存，请稍后重试。",
          tone: "error",
        });
      }
    } catch {
      setAttentionIdMessage({
        text: "Attention ID 没有保存，请检查网络后重试。",
        tone: "error",
      });
    } finally {
      setBusy(null);
    }
  }

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy("profile");
    setProfileMessage(null);
    try {
      const response = await fetch("/api/account/profile", {
        body: JSON.stringify({ display_name: form.get("display_name") }),
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      });
      setProfileMessage(
        response.ok ? "展示名已保存。" : "没有保存，请检查长度后重试。",
      );
    } catch {
      setProfileMessage("展示名没有保存，请检查网络后重试。");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="settings-stack">
      <section
        aria-labelledby="membership-status-title"
        className="settings-card account-membership-card"
      >
        <div className="account-membership-card__copy">
          <p className="settings-card__eyebrow">Member</p>
          <h2 id="membership-status-title">订阅状态</h2>
          <p>
            {membership.subscription
              ? membership.subscription.cancelAtPeriodEnd
                ? `当前${subscriptionStatusLabels[membership.subscription.status]}，权益持续至 ${membership.subscription.currentPeriodEndLabel}，到期后不再自动续费。`
                : `当前${subscriptionStatusLabels[membership.subscription.status]}，权益有效至 ${membership.subscription.currentPeriodEndLabel}。`
              : membership.hasMemberEntitlement
                ? "当前拥有 Member 权益，但没有可管理的自动续费订阅。"
                : "当前没有有效的 Member 订阅。"}
          </p>
        </div>
        <div className="account-membership-card__action">
          <span
            className={`account-membership-status${
              membership.subscription || membership.hasMemberEntitlement
                ? " account-membership-status--active"
                : ""
            }`}
          >
            {membership.subscription
              ? subscriptionStatusLabels[membership.subscription.status]
              : membership.hasMemberEntitlement
                ? "Member 权益"
                : "Free"}
          </span>
          <a
            className={`button account-membership-card__link ${
              membership.subscription ? "button--secondary" : "button--primary"
            }`}
            href="/membership"
            rel="noopener noreferrer"
            target="_blank"
          >
            <span>{membership.subscription ? "管理订阅" : "订阅"}</span>
            <ArrowUpRightIcon className="account-membership-card__external-icon" />
          </a>
        </div>
      </section>

      <section
        aria-labelledby="profile-settings-title"
        className="settings-card account-profile-settings"
      >
        <div className="account-profile-settings__intro">
          <p className="settings-card__eyebrow">公开身份</p>
          <h2 id="profile-settings-title">个人资料</h2>
          <p>展示名和 Attention ID 会显示在你的个人资料和内容署名中。</p>
        </div>

        <div className="account-profile-settings__section">
          <div className="account-profile-settings__copy">
            <h2>展示名</h2>
            <p>修改个人资料和内容署名中显示的名称。</p>
          </div>
          <form className="settings-form settings-inline-form" onSubmit={saveProfile}>
            <label className="sr-only" htmlFor="display-name">展示名</label>
            <div className="settings-inline-form__controls">
              <input
                defaultValue={displayName}
                id="display-name"
                maxLength={50}
                name="display_name"
                required
              />
              <button
                className="button button--secondary"
                disabled={busy !== null}
                type="submit"
              >
                保存展示名
              </button>
            </div>
            {profileMessage ? <p aria-live="polite">{profileMessage}</p> : null}
          </form>
        </div>

        <div className="account-profile-settings__section account-profile-settings__attention">
          <div className="account-profile-settings__copy">
            <h2 id="attention-id-title">Attention ID</h2>
            <p>显示在个人资料中的公开标识。未设置时不会显示系统生成的 ID。</p>
          </div>
          <form className="attention-id-form" onSubmit={saveAttentionId}>
            <label className="sr-only" htmlFor="attention-id">Attention ID</label>
            <div className="settings-inline-form__controls attention-id-form__controls">
              <div className="attention-id-field">
                <span aria-hidden="true">@</span>
                <input
                  aria-describedby="attention-id-rules attention-id-message"
                  autoCapitalize="none"
                  autoComplete="off"
                  autoCorrect="off"
                  disabled={attentionIdLocked || busy !== null}
                  id="attention-id"
                  maxLength={20}
                  minLength={6}
                  name="attention_id"
                  onChange={(event) =>
                    setAttentionIdDraft(event.target.value.toLowerCase())
                  }
                  pattern="[a-z][a-z0-9_-]{5,19}"
                  required
                  spellCheck={false}
                  value={attentionIdDraft}
                />
              </div>
              <button
                className="button button--secondary"
                disabled={
                  attentionIdLocked ||
                  busy !== null ||
                  attentionIdDraft.trim() === (attentionId ?? "")
                }
                type="submit"
              >
                {busy === "attention-id"
                  ? "保存中"
                  : attentionId
                    ? "保存更改"
                    : "设置"}
              </button>
            </div>
            <p className="attention-id-form__rules" id="attention-id-rules">
              6–20 个字符，以字母开头，只能使用字母、数字、_ 和 -。输入会自动转为小写；设置后不能清除，每 365 天可修改一次。
            </p>
            {attentionIdLocked && attentionIdNextChangeAt ? (
              <p className="attention-id-form__status">
                下次可在 {formatAttentionIdDate(attentionIdNextChangeAt)} 修改。
              </p>
            ) : null}
            <p
              aria-live="polite"
              className={`attention-id-form__message${
                attentionIdMessage?.tone === "error"
                  ? " attention-id-form__message--error"
                  : ""
              }`}
              id="attention-id-message"
            >
              {attentionIdMessage?.text ?? ""}
            </p>
          </form>
        </div>
      </section>

    </div>
  );
}
