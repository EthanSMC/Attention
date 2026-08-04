"use client";

import { useState, type FormEvent } from "react";

import type { DigestSettings } from "../server/digest-settings";

const commonTimezones = [
  ["Asia/Shanghai", "中国标准时间"],
  ["Asia/Hong_Kong", "香港时间"],
  ["Asia/Tokyo", "日本时间"],
  ["Europe/London", "伦敦时间"],
  ["America/New_York", "纽约时间"],
  ["America/Los_Angeles", "洛杉矶时间"],
  ["UTC", "UTC"],
] as const;

export function DigestSettingsForm({
  eligible,
  initial,
}: {
  eligible: boolean;
  initial: DigestSettings;
}) {
  const [settings, setSettings] = useState(initial);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timezones = commonTimezones.some(([value]) => value === settings.timezone)
    ? commonTimezones
    : ([[settings.timezone, settings.timezone], ...commonTimezones] as const);
  const windowOptions = [30, 60, 120, 240].includes(settings.windowMinutes)
    ? [30, 60, 120, 240]
    : [settings.windowMinutes, 30, 60, 120, 240];

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const domainSlugs = settings.domains
      .filter((domain) => form.get(`domain:${domain.slug}`) === "on")
      .map((domain) => domain.slug);
    setBusy(true);
    setMessage(null);
    const response = await fetch("/api/account/digests", {
      body: JSON.stringify({
        domain_slugs: domainSlugs,
        enabled: form.get("enabled") === "on",
        timezone: form.get("timezone"),
        window_minutes: Number(form.get("window_minutes")),
        window_start: form.get("window_start"),
      }),
      headers: { "Content-Type": "application/json" },
      method: "PUT",
    });
    const result = (await response.json().catch(() => ({}))) as {
      error?: { code?: string };
      settings?: {
        domains: DigestSettings["domains"];
        enabled: boolean;
        timezone: string;
        window_minutes: number;
        window_start: string;
      };
    };
    setBusy(false);
    if (response.ok && result.settings) {
      setSettings({
        domains: result.settings.domains,
        enabled: result.settings.enabled,
        timezone: result.settings.timezone,
        windowMinutes: result.settings.window_minutes,
        windowStart: result.settings.window_start,
      });
      setMessage("日报订阅已保存，将在所选时区的发送窗口内投递。");
      return;
    }
    setMessage(
      result.error?.code === "digest_entitlement_required"
        ? "Domain 日报是 Member 与 Filter 权益，请先开通会员。"
        : "没有保存，请检查时区和发送窗口后重试。",
    );
  }

  if (!eligible) {
    return (
      <section className="settings-card">
        <div>
          <p className="settings-card__eyebrow">Member 权益</p>
          <h2>Domain 每日 Email</h2>
          <p>开通 Member 后可订阅 AI Domain；Filter 资格也会自动解锁。</p>
          <a className="button button--primary" href="/membership">查看会员</a>
        </div>
      </section>
    );
  }

  return (
    <form className="settings-stack" onSubmit={save}>
      <section className="settings-card">
        <div>
          <p className="settings-card__eyebrow">订阅范围</p>
          <h2>Domain</h2>
          <p>第一版开放 AI；数据模型已支持未来新增的独立 Domain。</p>
        </div>
        <div className="settings-form">
          {settings.domains.map((domain) => (
            <label key={domain.slug}>
              <input
                defaultChecked={domain.active}
                name={`domain:${domain.slug}`}
                type="checkbox"
              />{" "}
              {domain.name}
            </label>
          ))}
          <label>
            <input defaultChecked={settings.enabled} name="enabled" type="checkbox" />{" "}
            启用每日 Email
          </label>
        </div>
      </section>

      <section className="settings-card">
        <div>
          <p className="settings-card__eyebrow">投递时间</p>
          <h2>账号时区与窗口</h2>
          <p>Worker 会按账号当地日期调度，并在真正发送前再次检查权益与公开资格。</p>
        </div>
        <div className="settings-form">
          <label htmlFor="digest-timezone">时区</label>
          <select defaultValue={settings.timezone} id="digest-timezone" name="timezone">
            {timezones.map(([value, label]) => (
              <option key={value} value={value}>{label} · {value}</option>
            ))}
          </select>
          <label htmlFor="digest-window-start">窗口开始</label>
          <input
            defaultValue={settings.windowStart}
            id="digest-window-start"
            name="window_start"
            required
            type="time"
          />
          <label htmlFor="digest-window-minutes">窗口长度</label>
          <select
            defaultValue={String(settings.windowMinutes)}
            id="digest-window-minutes"
            name="window_minutes"
          >
            {windowOptions.map((minutes) => (
              <option key={minutes} value={minutes}>{minutes} 分钟</option>
            ))}
          </select>
          {message ? <p aria-live="polite">{message}</p> : null}
          <button className="button button--secondary" disabled={busy} type="submit">
            {busy ? "保存中…" : "保存日报设置"}
          </button>
        </div>
      </section>
    </form>
  );
}
