"use client";

import { useRouter } from "next/navigation";
import type { ChangeEvent } from "react";

import { ChevronDownIcon } from "./icons";

const domains = [
  { href: "/ai", label: "AI", value: "ai" },
] as const;

export function DomainSwitcher({ current }: { current: string }) {
  const router = useRouter();

  function changeDomain(event: ChangeEvent<HTMLSelectElement>) {
    const domain = domains.find((candidate) => candidate.value === event.target.value);
    if (domain) router.push(domain.href);
  }

  return (
    <label className="domain-switcher">
      <span className="sr-only">选择领域</span>
      <select aria-label="选择领域" onChange={changeDomain} value={current}>
        {domains.map((domain) => (
          <option key={domain.value} value={domain.value}>
            {domain.label}
          </option>
        ))}
      </select>
      <ChevronDownIcon />
    </label>
  );
}
