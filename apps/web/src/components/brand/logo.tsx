import { useId } from "react";
import { cn } from "../../lib/cn.ts";

/**
 * The Otuken mark: a protective sky ring around a mountain ridge, with a
 * single star marking the center — centrality, protection, nature and sky.
 */
export function LogoMark({ className, title }: { className?: string; title?: string }) {
  const gradientId = useId();
  return (
    <svg
      viewBox="0 0 48 48"
      className={cn("size-10", className)}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      <defs>
        <linearGradient
          id={gradientId}
          x1="6"
          y1="6"
          x2="42"
          y2="42"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#9BE7FF" />
          <stop offset="1" stopColor="#7B83FF" />
        </linearGradient>
      </defs>
      <circle
        cx="24"
        cy="24"
        r="19.5"
        fill="none"
        stroke={`url(#${gradientId})`}
        strokeWidth="2.4"
        opacity="0.85"
      />
      <path
        d="M10.5 34.5 19.5 21.8l4.6 5.8 6.9-11 7.5 17.9Z"
        fill={`url(#${gradientId})`}
        stroke={`url(#${gradientId})`}
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <circle cx="31" cy="10.6" r="2.1" fill="#FFFFFF" />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <LogoMark className="size-8" />
      <span className="text-lg font-semibold tracking-[0.02em]">Otuken</span>
    </span>
  );
}
