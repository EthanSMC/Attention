"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type AdminEntitlementAction =
  | "revoke_filter"
  | "set_filter"
  | "set_member";
type AdminEntitlementTier = "filter" | "free" | "member";

const actionLabels: Record<AdminEntitlementAction, string> = {
  revoke_filter: "撤销 Filter",
  set_filter: "设为 Filter",
  set_member: "设为 Member",
};

function normalizeAdminEntitlementReason(value: string): string {
  return value.normalize("NFKC").trim();
}

export function isValidAdminEntitlementReason(value: string): boolean {
  const normalized = normalizeAdminEntitlementReason(value);
  return normalized.length >= 3 && normalized.length <= 500;
}

export function adminEntitlementReasonMessage(value: string): string {
  const normalized = normalizeAdminEntitlementReason(value);
  if (normalized.length === 0) {
    return "先填写至少 3 个字符的变更原因。";
  }
  if (normalized.length < 3) {
    return `还需填写 ${3 - normalized.length} 个字符，才能选择操作。`;
  }
  if (normalized.length > 500) {
    return "变更原因不能超过 500 个字符。";
  }
  return "原因已满足要求，请选择操作。";
}

function currentTierDisabledReason(
  action: AdminEntitlementAction,
  tier: AdminEntitlementTier,
): string | null {
  if (action === "set_member" && tier === "member") {
    return "当前已是 Member。";
  }
  if (action === "set_filter" && tier === "filter") {
    return "当前已是 Filter。";
  }
  if (action === "revoke_filter" && tier !== "filter") {
    return "仅当前为 Filter 时可撤销。";
  }
  return null;
}

export function adminEntitlementActionDisabledReason({
  action,
  currentTier,
  pending,
  reason,
}: {
  action: AdminEntitlementAction;
  currentTier: AdminEntitlementTier;
  pending: boolean;
  reason: string;
}): string | null {
  if (pending) return "正在执行权益变更。";
  const tierReason = currentTierDisabledReason(action, currentTier);
  if (tierReason) return tierReason;
  if (!isValidAdminEntitlementReason(reason)) {
    return adminEntitlementReasonMessage(reason);
  }
  return null;
}

function safeErrorMessage(code: unknown): string {
  if (code === "account_not_active") return "目标账号当前不可修改。";
  if (code === "account_not_found") return "目标账号不存在或已不可用。";
  if (code === "admin_required") return "当前账号没有管理员权限。";
  if (code === "admin_unavailable") return "管理员配置当前不可用。";
  if (code === "invalid_entitlement_change") return "请检查操作与变更原因。";
  return "操作未完成，请稍后重试。";
}

export function AdminEntitlementConfirmation({
  action,
  onCancel,
  onConfirm,
  pending,
  reason,
  targetLabel,
}: {
  action: AdminEntitlementAction;
  onCancel: () => void;
  onConfirm: () => void;
  pending: boolean;
  reason: string;
  targetLabel: string;
}) {
  return (
    <div className="admin-confirmation-backdrop">
      <section
        aria-labelledby="admin-confirmation-title"
        aria-modal="true"
        className="admin-confirmation"
        role="dialog"
      >
        <p className="eyebrow">明确确认</p>
        <h3 id="admin-confirmation-title">{actionLabels[action]}</h3>
        <dl>
          <div>
            <dt>目标账号</dt>
            <dd>{targetLabel}</dd>
          </div>
          <div>
            <dt>变更原因</dt>
            <dd>{reason}</dd>
          </div>
        </dl>
        <p className="admin-confirmation__warning">
          确认后权益会立即生效，并写入不可从管理页面修改的审计记录。
        </p>
        <div className="admin-confirmation__actions">
          <button
            className="button button--secondary"
            disabled={pending}
            onClick={onCancel}
            type="button"
          >
            取消
          </button>
          <button
            className="button button--primary"
            disabled={pending}
            onClick={onConfirm}
            type="button"
          >
            {pending ? "执行中…" : "确认并执行"}
          </button>
        </div>
      </section>
    </div>
  );
}

export function AdminUserEntitlementControl({
  currentTier,
  targetAccountId,
  targetLabel,
}: {
  currentTier: AdminEntitlementTier;
  targetAccountId: string;
  targetLabel: string;
}) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] =
    useState<AdminEntitlementAction | null>(null);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const validReason = isValidAdminEntitlementReason(reason);
  const reasonFieldId = `admin-entitlement-reason-${targetAccountId}`;
  const reasonHelpId = `admin-entitlement-reason-help-${targetAccountId}`;
  const actionStateId = `admin-entitlement-action-state-${targetAccountId}`;
  const currentTierNotes = (
    ["set_member", "set_filter", "revoke_filter"] as const
  )
    .map((action) => currentTierDisabledReason(action, currentTier))
    .filter((message): message is string => message !== null)
    .map((message) => message.replace(/。$/u, ""))
    .join("；");

  async function confirmChange(): Promise<void> {
    if (!confirmation || !validReason || pending) return;
    setPending(true);
    setFeedback(null);
    try {
      const response = await fetch(
        `/api/admin/users/${encodeURIComponent(targetAccountId)}/entitlements`,
        {
          body: JSON.stringify({
            action: confirmation,
            confirmed: true,
            reason: normalizeAdminEntitlementReason(reason),
          }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        },
      );
      const result = (await response.json().catch(() => null)) as
        | { error?: { code?: unknown } }
        | null;
      if (!response.ok) {
        setFeedback(safeErrorMessage(result?.error?.code));
        return;
      }
      setConfirmation(null);
      setReason("");
      setFeedback("权益已更新并写入审计。");
      router.refresh();
    } catch {
      setFeedback("网络异常，操作未完成。请确认状态后再重试。");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="admin-entitlement-control">
      <label htmlFor={reasonFieldId}>
        <span>变更原因</span>
        <textarea
          aria-describedby={reasonHelpId}
          aria-invalid={reason.length > 0 && !validReason}
          id={reasonFieldId}
          maxLength={500}
          onChange={(event) => {
            setReason(event.target.value);
            setFeedback(null);
          }}
          placeholder="必填，3–500 字"
          rows={2}
          value={reason}
        />
      </label>
      <p
        aria-live="polite"
        className="admin-entitlement-control__reason-help"
        id={reasonHelpId}
      >
        {adminEntitlementReasonMessage(reason)}
      </p>
      <div className="admin-entitlement-control__actions">
        {(
          ["set_member", "set_filter", "revoke_filter"] as const
        ).map((action) => {
          const disabledReason = adminEntitlementActionDisabledReason({
            action,
            currentTier,
            pending,
            reason,
          });
          return (
            <button
              aria-describedby={`${reasonHelpId} ${actionStateId}`}
              className="button button--secondary"
              disabled={disabledReason !== null}
              key={action}
              onClick={() => setConfirmation(action)}
              title={disabledReason ?? undefined}
              type="button"
            >
              {actionLabels[action]}
            </button>
          );
        })}
      </div>
      <p
        className="admin-entitlement-control__action-state"
        id={actionStateId}
      >
        当前不可用：{currentTierNotes}。
      </p>
      <p aria-live="polite" className="admin-entitlement-control__feedback">
        {feedback}
      </p>
      {confirmation ? (
        <AdminEntitlementConfirmation
          action={confirmation}
          onCancel={() => setConfirmation(null)}
          onConfirm={() => void confirmChange()}
          pending={pending}
          reason={normalizeAdminEntitlementReason(reason)}
          targetLabel={targetLabel}
        />
      ) : null}
    </div>
  );
}
