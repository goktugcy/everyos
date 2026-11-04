import type { LucideIcon } from "lucide-react";

/** Purpose-drawn document artwork, in one optical size rather than a miniature app badge. */
export function FileTypeArt({ kind, fallback: Fallback }: { kind: string; fallback: LucideIcon }) {
  switch (kind) {
    case "document":
    case "text":
      return (
        <g stroke="white" strokeWidth="2.5" strokeLinecap="round">
          <path d="M5 6h14" strokeWidth="4" />
          <path d="M5 14h23M5 20h23M5 26h15" opacity=".85" />
        </g>
      );
    case "pdf":
      return (
        <g stroke="white" strokeWidth="2.2" strokeLinejoin="round">
          <path
            d="M16 8C12 4 7 4 3 5v21c5-1 9 0 13 3 4-3 8-4 13-3V5c-4-1-9-1-13 3Z"
            fill="white"
            fillOpacity=".16"
          />
          <path d="M16 8v21M7 11l5 1M7 17l5 1M20 12l5-1M20 18l5-1" strokeLinecap="round" />
        </g>
      );
    case "spreadsheet":
      return (
        <g stroke="white" strokeWidth="1.8" strokeLinejoin="round">
          <rect x="3" y="4" width="26" height="25" rx="3" fill="white" fillOpacity=".12" />
          <path d="M3 12h26M3 20h26M12 12v17M21 12v17" opacity=".85" />
          <path d="M6 5h20a2 2 0 0 1 2 2v4H4V7a2 2 0 0 1 2-2Z" fill="white" stroke="none" />
        </g>
      );
    case "presentation":
      return (
        <g stroke="white" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4" width="26" height="20" rx="3" fill="white" fillOpacity=".12" />
          <path d="M16 24v6M11 30h10M8 18l6-5 5 3 6-7" />
          <path d="M20 9h5v5" />
        </g>
      );
    case "image":
      return (
        <g>
          <rect
            x="2"
            y="3"
            width="28"
            height="26"
            rx="4"
            fill="white"
            fillOpacity=".18"
            stroke="white"
            strokeWidth="1.8"
          />
          <circle cx="22" cy="10" r="3" fill="white" />
          <path d="m4 24 8-11 8 10 5-5 4 6v1a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z" fill="white" />
        </g>
      );
    case "video":
      return (
        <g>
          <rect
            x="2"
            y="5"
            width="28"
            height="24"
            rx="4"
            fill="white"
            fillOpacity=".17"
            stroke="white"
            strokeWidth="1.8"
          />
          <path d="M3 11h26" stroke="white" strokeWidth="1.8" />
          <path d="m8 5-3 6m11-6-3 6m11-6-3 6" stroke="white" strokeWidth="2.8" />
          <path
            d="M13 16a1 1 0 0 1 1.5-.87l7 4a1 1 0 0 1 0 1.74l-7 4A1 1 0 0 1 13 24Z"
            fill="white"
          />
        </g>
      );
    case "audio":
      return (
        <g fill="white">
          <path d="M12 7a2 2 0 0 1 1.6-2L28 2v6l-13 3v13h-3Z" />
          <path d="M26 6h2v15h-2Z" />
          <ellipse cx="9" cy="25" rx="6" ry="4.5" transform="rotate(-18 9 25)" />
          <ellipse cx="23" cy="22" rx="5" ry="4" transform="rotate(-18 23 22)" />
        </g>
      );
    case "archive":
      return (
        <g fill="white">
          <path d="M10 1h12v15H10Z" opacity=".12" />
          {[2, 6, 10, 14].map((y) => (
            <g key={y}>
              <rect x="11" y={y} width="5" height="2" rx=".5" />
              <rect x="16" y={y + 2} width="5" height="2" rx=".5" />
            </g>
          ))}
          <rect
            x="10"
            y="19"
            width="12"
            height="11"
            rx="3"
            fillOpacity=".2"
            stroke="white"
            strokeWidth="2.2"
          />
          <rect x="14" y="23" width="4" height="3" rx="1" />
        </g>
      );
    case "code":
    case "data":
      return (
        <g stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          {kind === "code" ? (
            <path d="m9 8-7 8 7 8M23 8l7 8-7 8M19 4l-6 24" />
          ) : (
            <>
              <path d="M11 4H8a3 3 0 0 0-3 3v5c0 2-1 3-3 4 2 1 3 2 3 4v5a3 3 0 0 0 3 3h3M21 4h3a3 3 0 0 1 3 3v5c0 2 1 3 3 4-2 1-3 2-3 4v5a3 3 0 0 1-3 3h-3" />
              <path d="M16 12v.1M16 20v.1" strokeWidth="3.8" />
            </>
          )}
        </g>
      );
    case "disk":
      return (
        <g fill="white">
          <circle cx="16" cy="16" r="13" fillOpacity=".18" stroke="white" strokeWidth="2" />
          <path
            d="M5 11A12 12 0 0 1 21 5l-3 7a5 5 0 0 0-6 2ZM27 21a12 12 0 0 1-16 6l3-7a5 5 0 0 0 6-2Z"
            fillOpacity=".55"
          />
          <circle cx="16" cy="16" r="3" />
        </g>
      );
    default:
      return <Fallback x="2" y="2" width="28" height="28" color="white" strokeWidth={1.9} />;
  }
}
