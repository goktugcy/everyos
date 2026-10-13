import { useId, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { useTrashIconState } from "./trash-status.tsx";

/** Open wire basket with transparent gaps; paper appears only after a real trash listing. */
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
  const metal = useId();
  return (
    <svg
      viewBox="0 0 64 64"
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
      <defs>
        <linearGradient id={metal} x1="10" y1="0" x2="54" y2="0" gradientUnits="userSpaceOnUse">
          <stop stopColor="#83949f" />
          <stop offset="0.22" stopColor="#e5edf2" />
          <stop offset="0.5" stopColor="#b4c3ce" />
          <stop offset="0.76" stopColor="#f5f8fa" />
          <stop offset="1" stopColor="#7e909d" />
        </linearGradient>
      </defs>
      <g stroke="#748592" strokeWidth="0.85" opacity="0.45">
        <path d="m15 16 7 35m0-39 5 36m5-38v38m10-36-5 36m12-32-7 35" />
        <path d="M12 21q20-12 40 0M13 27q19-11 38 0M14 33q18-10 36 0M15 39q17-9 34 0M16 45q16-8 32 0" />
      </g>
      <ellipse cx="32" cy="16" rx="21" ry="7" stroke="#677986" strokeWidth="2.8" />
      <ellipse cx="32" cy="16" rx="21" ry="7" stroke={`url(#${metal})`} />
      {state === "full" ? (
        <g stroke="#9aa9b3" strokeWidth="0.8" fill="#edf2f5">
          <path d="m17 25-3-15 6-6 11 3 2 18-9 12Z" />
          <path d="m29 31-6-15 8-8 10 4 5 19-8 13Z" fill="#ffffff" />
          <path d="m35 42 1-20 11-8 5 7-4 20-7 8Z" fill="#dce5eb" />
          <path d="m20 9 4 9-6 6m14-11 5 9-7 8m16-10-5 8 4 7" fill="none" />
        </g>
      ) : null}
      <g stroke={`url(#${metal})`} strokeWidth="0.85">
        <path d="m14 20 7 32m-1-29 5 32m1-30 2 32m4-31v32m6-33-2 32m8-34-5 32m11-35-7 32" />
        <path d="M12 24q20 12 40 0M13 30q19 11 38 0M14 36q18 10 36 0M15 42q17 9 34 0M16 48q16 8 32 0" />
      </g>
      <path
        d="m11 16 7 37c2 7 26 7 28 0l7-37M18 52c4 6 24 6 28 0"
        stroke="#677986"
        strokeWidth="2.5"
      />
      <path
        d="m11 16 7 37c2 7 26 7 28 0l7-37M18 52c4 6 24 6 28 0M11 16c0 9 42 9 42 0"
        stroke={`url(#${metal})`}
      />
      {state === "unknown" ? (
        <>
          <circle cx="49" cy="47" r="11" fill="rgb(var(--everyos-surface))" />
          <path d="M46 44a3 3 0 1 1 5.25 2L49 48.5m0 4.5h.01" />
        </>
      ) : null}
    </svg>
  );
}
