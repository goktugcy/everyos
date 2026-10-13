import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { useTrashIconState } from "./trash-status.tsx";

/** A closed empty bin or a bin with visible paper; unknown never masquerades as empty. */
export function TrashGlyph({
  className,
  style,
  strokeWidth = 1.7,
}: {
  className?: string;
  style?: CSSProperties;
  strokeWidth?: number;
}) {
  const state = useTrashIconState();
  const { t } = useTranslation();
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
      style={style}
      data-trash-state={state}
    >
      <title>{t(`trash.iconStates.${state}`)}</title>
      {state === "full" ? (
        <>
          <path d="m7 8-1-4 4-2 3 3 4-2 2 5" fill="currentColor" fillOpacity="0.35" />
          <path d="m10 3 1 4m4-2 1 3M3 9l18-2" />
        </>
      ) : (
        <path d="M3 7h18M9 7V4h6v3" />
      )}
      <path d="m5 9 1.2 11a2 2 0 0 0 2 1.8h7.6a2 2 0 0 0 2-1.8L19 9M9 11v7m6-7v7" />
      {state === "unknown" ? (
        <>
          <circle cx="18" cy="17" r="5" fill="rgb(var(--everyos-surface))" />
          <path d="M16.8 15.6a1.2 1.2 0 1 1 2.1.8L18 17.4m0 1.8h.01" />
        </>
      ) : null}
    </svg>
  );
}
