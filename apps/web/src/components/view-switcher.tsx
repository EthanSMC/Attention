import Link from "next/link";

import { GridIcon, ListIcon } from "./icons";

export type ViewMode = "cards" | "list";

const viewOptions: Array<{
  icon: typeof GridIcon;
  label: string;
  value: ViewMode;
}> = [
  { icon: GridIcon, label: "卡片", value: "cards" },
  { icon: ListIcon, label: "列表", value: "list" },
];

type ViewSwitcherProps = {
  ariaLabel: string;
  value: ViewMode;
} &
  (
    | { hrefs: Record<ViewMode, string>; onChange?: never }
    | { hrefs?: never; onChange: (value: ViewMode) => void }
  );

export function ViewSwitcher({
  ariaLabel,
  hrefs,
  onChange,
  value,
}: ViewSwitcherProps) {
  return (
    <div aria-label={ariaLabel} className="view-switcher" role="group">
      {viewOptions.map(({ icon: Icon, label, value: optionValue }) => {
        const content = (
          <>
            <Icon />
            <span>{label}</span>
          </>
        );

        if (hrefs) {
          return (
            <Link
              aria-current={value === optionValue ? "true" : undefined}
              href={hrefs[optionValue]}
              key={optionValue}
            >
              {content}
            </Link>
          );
        }

        return (
          <button
            aria-label={`${label}视图`}
            aria-pressed={value === optionValue}
            key={optionValue}
            onClick={() => onChange(optionValue)}
            type="button"
          >
            {content}
          </button>
        );
      })}
    </div>
  );
}
