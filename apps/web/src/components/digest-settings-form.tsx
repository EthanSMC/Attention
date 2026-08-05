"use client";

import { useState, type FormEvent } from "react";

import { latestDigestWindowStart } from "../lib/digest-time";
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
  deliveryEmail,
  eligible,
  initial,
}: {
  deliveryEmail: string | null;
  eligible: boolean;
  initial: DigestSettings;
}) {
  const [settings, setSettings] = useState(initial);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timezones = commonTimezones.some(([value]) => value === settings.timezone)
    ? commonTimezones
    : ([[settings.timezone, settings.timezone], ...commonTimezones] as const);
  const selectedDomainCount = settings.domains.filter((domain) => domain.active).length;
  const latestWindowStart = latestDigestWindowStart(settings.windowMinutes);

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
        window_minutes: settings.windowMinutes,
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
      setMessage("日报订阅已保存，报童会按你的设置送达。没有新内容时不会发送。");
      return;
    }
    setMessage(
      result.error?.code === "digest_entitlement_required"
        ? "日报是 Member 与 Filter 权益，请先开通会员。"
        : "没有保存，请检查日报、时区和送达时间后重试。",
    );
  }

  if (!eligible) {
    return (
      <section className="settings-card digest-settings__locked">
        <div>
          <p className="settings-card__eyebrow">Member 权益</p>
          <h2>解锁日报订阅</h2>
          <p>开通 Member 后，可以选择日报并让报童按时送达。</p>
          <a className="button button--primary" href="/membership">查看会员</a>
        </div>
      </section>
    );
  }

  return (
    <form className="settings-stack digest-settings" onSubmit={save}>
      <section className="settings-card digest-settings__section">
        <div className="digest-settings__step-heading">
          <span aria-hidden="true" className="digest-settings__step">01</span>
          <div>
            <p className="settings-card__eyebrow">第一步 · 订阅</p>
            <h2>选择日报</h2>
            <p>选中你想每天收到的内容主题，可以订阅一份或多份。</p>
          </div>
        </div>

        <fieldset className="digest-domain-picker">
          <legend className="sr-only">选择日报</legend>
          {settings.domains.map((domain) => (
            <label
              className={`digest-domain-option${domain.active ? " digest-domain-option--selected" : ""}`}
              key={domain.slug}
            >
              <input
                checked={domain.active}
                name={`domain:${domain.slug}`}
                onChange={(event) => {
                  const active = event.target.checked;
                  setSettings((current) => ({
                    ...current,
                    domains: current.domains.map((item) =>
                      item.slug === domain.slug ? { ...item, active } : item,
                    ),
                  }));
                }}
                type="checkbox"
              />
              <span className="digest-domain-option__copy">
                <strong>{domain.name} 日报</strong>
                <small>公开内容中符合该主题的新内容</small>
              </span>
              <span className="digest-domain-option__status">
                {domain.active ? "已订阅" : "订阅"}
              </span>
            </label>
          ))}
        </fieldset>

        <label className="digest-enable-option">
          <input
            checked={settings.enabled}
            name="enabled"
            onChange={(event) => setSettings((current) => ({
              ...current,
              enabled: event.target.checked,
            }))}
            type="checkbox"
          />
          <span>
            <strong>开启报童投递</strong>
            <small>{selectedDomainCount ? `已选择 ${selectedDomainCount} 份日报` : "先选择一份日报"}</small>
          </span>
        </label>
      </section>

      <section className="settings-card digest-settings__section">
        <div className="digest-settings__step-heading">
          <span aria-hidden="true" className="digest-settings__step">02</span>
          <div>
            <p className="settings-card__eyebrow">第二步 · 送达</p>
            <h2>设置报童怎么送</h2>
            <p>选择发送时间和渠道。报童会按这个时间检查当天的新内容。</p>
          </div>
        </div>

        <div className="digest-delivery-layout">
          <div className="digest-delivery-fields">
            <div className="digest-field digest-field--timezone">
              <label htmlFor="digest-timezone">时区</label>
              <select defaultValue={settings.timezone} id="digest-timezone" name="timezone">
                {timezones.map(([value, label]) => (
                  <option key={value} value={value}>{label} · {value}</option>
                ))}
              </select>
            </div>
            <div className="digest-field">
              <label htmlFor="digest-window-start">发送时间</label>
              <input
                defaultValue={settings.windowStart}
                id="digest-window-start"
                max={latestWindowStart}
                name="window_start"
                required
                type="time"
              />
              <small>
                系统会在此后的 {settings.windowMinutes} 分钟内完成发送，最晚可选 {latestWindowStart}。
              </small>
            </div>
          </div>

          <fieldset className="digest-channel-picker">
            <legend>发送渠道</legend>
            <label className="digest-channel-option digest-channel-option--selected">
              <input defaultChecked name="delivery_channel" type="radio" value="email" />
              <span>
                <strong>Email</strong>
                <small>{deliveryEmail ? `送到 ${deliveryEmail}` : "送到你的账号邮箱"}</small>
              </span>
              <span className="digest-channel-option__status">当前支持</span>
            </label>
            <div aria-disabled="true" className="digest-channel-option digest-channel-option--disabled">
              <span>
                <strong>微信 / 企业微信</strong>
                <small>绑定 Channel 后开放</small>
              </span>
              <span className="digest-channel-option__status">即将支持</span>
            </div>
          </fieldset>
        </div>

        <div className="digest-settings__actions">
          {message ? <p aria-live="polite" className="digest-settings__message">{message}</p> : <p className="digest-settings__message">没有符合条件的新内容时不会发送。</p>}
          <button className="button button--primary" disabled={busy} type="submit">
            {busy ? "保存中…" : "保存设置"}
          </button>
        </div>
      </section>
    </form>
  );
}
