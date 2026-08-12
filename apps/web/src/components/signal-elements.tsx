import type {
  EffectiveVisibility,
  EnrichmentStatus,
  SourceTone,
  Visibility,
} from "../lib/attention";
import { BotIcon, GlobeIcon, LockIcon, WarningIcon } from "./icons";

export function SourceSignal({
  initial,
  source,
  tone,
}: {
  initial: string;
  source: string;
  tone: SourceTone;
}) {
  return (
    <div className={`source-signal source-signal--${tone}`}>
      <span aria-hidden="true" className="source-signal__trace source-signal__trace--human" />
      <span aria-hidden="true" className="source-signal__trace source-signal__trace--ai" />
      <span aria-label={`${source} 来源图标`} className="source-signal__glyph" role="img">
        {initial}
      </span>
      <span className="source-signal__handoff">
        <span>人筛选</span>
        <span aria-hidden="true">→</span>
        <span>AI 整理</span>
      </span>
    </div>
  );
}

export function EnrichmentBadge({ status }: { status: EnrichmentStatus }) {
  const labels: Record<EnrichmentStatus, string> = {
    processing: "摘要待补全",
    ready: "AI 摘要可用",
    unavailable: "无可用摘要",
  };

  return (
    <span className={`status-label status-label--${status}`}>
      {status === "unavailable" ? <WarningIcon /> : <BotIcon />}
      {labels[status]}
    </span>
  );
}

export function VisibilityBadge({
  effectiveVisibility,
}: {
  effectiveVisibility: EffectiveVisibility;
}) {
  const config: Record<
    EffectiveVisibility,
    { icon: typeof GlobeIcon; label: string }
  > = {
    public: { icon: GlobeIcon, label: "公开" },
    private: { icon: LockIcon, label: "私密" },
    paused: { icon: WarningIcon, label: "公开已暂停" },
    blocked: { icon: WarningIcon, label: "已阻断" },
  };
  const { icon: Icon, label } = config[effectiveVisibility];

  return (
    <span className={`status-label status-label--${effectiveVisibility}`}>
      <Icon />
      {label}
    </span>
  );
}

export function VisibilityChoice({
  description,
  disabled = false,
  id,
  name,
  onChange,
  value,
  visibility,
}: {
  description: string;
  disabled?: boolean;
  id: string;
  name: string;
  onChange: (visibility: Visibility) => void;
  value: Visibility;
  visibility: Visibility;
}) {
  const isPublic = value === "public";
  const Icon = isPublic ? GlobeIcon : LockIcon;

  return (
    <label className="visibility-choice" htmlFor={id}>
      <input
        checked={visibility === value}
        disabled={disabled}
        id={id}
        name={name}
        onChange={() => onChange(value)}
        type="radio"
        value={value}
      />
      <span aria-hidden="true" className="visibility-choice__radio" />
      <span className="visibility-choice__copy">
        <span className="visibility-choice__title">
          <Icon />
          {isPublic ? "公开" : "私密"}
          {isPublic ? <span className="visibility-choice__default">Filter 默认</span> : null}
        </span>
        <span className="visibility-choice__description">{description}</span>
      </span>
    </label>
  );
}
