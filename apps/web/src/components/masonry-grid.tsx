"use client";

import { useEffect, useRef, type ReactNode } from "react";

function measureGrid(grid: HTMLDivElement) {
  const style = window.getComputedStyle(grid);
  const rowHeight = Number.parseFloat(style.gridAutoRows);
  const rowGap = Number.parseFloat(style.rowGap);
  if (!Number.isFinite(rowHeight) || rowHeight <= 0) return;

  for (const child of Array.from(grid.children)) {
    if (!(child instanceof HTMLElement)) continue;
    const content = child.firstElementChild;
    if (!(content instanceof HTMLElement)) continue;
    const height = content.getBoundingClientRect().height;
    const span = Math.max(1, Math.ceil((height + rowGap) / (rowHeight + rowGap)));
    const nextValue = `span ${span}`;
    if (child.style.gridRowEnd !== nextValue) {
      child.style.gridRowEnd = nextValue;
    }
  }
}

export function MasonryGrid({ children }: { children: ReactNode }) {
  const gridRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;

    let frame = 0;
    const scheduleMeasurement = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => measureGrid(grid));
    };
    const observer = new ResizeObserver(scheduleMeasurement);

    observer.observe(grid);
    for (const child of Array.from(grid.children)) {
      if (child.firstElementChild) observer.observe(child.firstElementChild);
    }
    scheduleMeasurement();

    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [children]);

  return (
    <div className="masonry-feed" ref={gridRef} role="list">
      {children}
    </div>
  );
}
