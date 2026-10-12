import { useLayoutEffect, useRef } from "react";
import { cn } from "../../lib/cn.ts";

/** Fit names after fonts and container sizes settle, including unbroken file names. */
export function IconLabel({ text, className }: { text: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    let disposed = false;
    let previousWidth = 0;
    const fit = () => {
      if (disposed || element.clientWidth === 0) return;
      previousWidth = element.clientWidth;
      element.style.fontSize = "";
      const computed = getComputedStyle(element);
      const preferred = Math.max(9, Number.parseFloat(computed.fontSize));
      const limit = Number.parseFloat(computed.maxHeight);
      for (let size = preferred; ; size = Math.max(9, size - 0.25)) {
        element.style.fontSize = `${size}px`;
        if (element.scrollHeight <= limit || size === 9) break;
      }
      const caption = element.parentElement!;
      caption.dataset.overflow = String(element.scrollHeight > limit);
      const grid = element.closest("[data-icon-grid]")?.getBoundingClientRect();
      const expandedWidth = Math.min(256, grid?.width ?? window.innerWidth - 24);
      caption.style.setProperty("--everyos-caption-width", `${expandedWidth}px`);
      caption.dataset.align =
        element.getBoundingClientRect().left + expandedWidth > (grid?.right ?? window.innerWidth)
          ? "right"
          : "left";
    };
    fit();
    const observer = new ResizeObserver(() => {
      if (element.clientWidth !== previousWidth) fit();
    });
    observer.observe(element);
    if (document.fonts.status !== "loaded") void document.fonts.ready.then(fit);
    return () => {
      disposed = true;
      observer.disconnect();
    };
  }, [text]);
  return (
    <span className="everyos-icon-caption relative block w-full">
      <span
        ref={ref}
        title={text}
        data-icon-label
        className={cn(
          "block max-h-9 w-full overflow-hidden [overflow-wrap:anywhere] text-center text-[0.72rem] font-medium leading-[1.2] text-fg",
          className,
        )}
      >
        {text}
      </span>
      <span aria-hidden className={cn("everyos-caption-expanded", className)}>
        {text}
      </span>
    </span>
  );
}
