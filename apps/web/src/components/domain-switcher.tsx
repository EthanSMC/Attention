"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";

import { CheckIcon, ChevronDownIcon } from "./icons";

const domains = [
  {
    description: "学习、产品与技术",
    href: "/ai",
    label: "AI",
    value: "ai",
  },
] as const;

export function DomainSwitcher({ current }: { current: string }) {
  const router = useRouter();
  const menuId = useId();
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const selectedItemRef = useRef<HTMLButtonElement>(null);
  const currentDomain = domains.find((domain) => domain.value === current) ?? domains[0];

  useEffect(() => {
    if (!isOpen) return;

    function closeOnOutsidePress(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setIsOpen(false);
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setIsOpen(false);
      triggerRef.current?.focus();
    }

    document.addEventListener("pointerdown", closeOnOutsidePress);
    document.addEventListener("keydown", closeOnEscape);
    selectedItemRef.current?.focus();

    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePress);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [isOpen]);

  function chooseDomain(domain: (typeof domains)[number]) {
    setIsOpen(false);
    triggerRef.current?.focus();
    if (domain.value !== current) router.push(domain.href);
  }

  return (
    <div className="domain-switcher" ref={containerRef}>
      <button
        aria-controls={menuId}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        aria-label={`切换领域，当前为 ${currentDomain.label}`}
        className="domain-switcher__trigger"
        onClick={() => setIsOpen((open) => !open)}
        ref={triggerRef}
        type="button"
      >
        <span>{currentDomain.label}</span>
        <ChevronDownIcon />
      </button>

      {isOpen ? (
        <div aria-label="选择领域" className="domain-switcher__menu" id={menuId} role="listbox">
          {domains.map((domain) => {
            const isSelected = domain.value === current;

            return (
              <button
                aria-selected={isSelected}
                className="domain-switcher__option"
                key={domain.value}
                onClick={() => chooseDomain(domain)}
                ref={isSelected ? selectedItemRef : undefined}
                role="option"
                type="button"
              >
                <span className="domain-switcher__copy">
                  <strong>{domain.label}</strong>
                  <small>{domain.description}</small>
                </span>
                {isSelected ? <CheckIcon aria-hidden="true" /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
