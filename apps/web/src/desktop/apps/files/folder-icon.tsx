import type { FolderIconPresetId, FolderIconSpec } from "@otuken/shared";
import { Folder, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { usePreferences } from "../../state/preferences-store.ts";
import type { FileLocation } from "./lib.ts";

const COLORS: Partial<Record<FolderIconPresetId, string>> = {
  amber: "#f59e0b",
  green: "#22c55e",
  violet: "#a78bfa",
};

function UploadedIcon({ id, fallback }: { id: string; fallback: React.ReactNode }) {
  const [failed, setFailed] = useState(false);
  return failed ? (
    fallback
  ) : (
    <img
      src={`/api/folder-icons/${encodeURIComponent(id)}/image`}
      alt=""
      draggable={false}
      loading="lazy"
      className="size-full object-contain"
      onError={() => setFailed(true)}
    />
  );
}

/** One folder appearance across the desktop and both Files views. */
export function FolderIcon({
  location,
  spec,
  size = 56,
  className,
  badge: Badge,
}: {
  location?: FileLocation | null;
  spec?: FolderIconSpec;
  size?: number;
  className?: string;
  badge?: LucideIcon | null;
}) {
  const appearance = usePreferences((state) => state.appearance);
  const selected = spec ??
    appearance.folderIcons?.find(
      (item) => location && item.root === location.root && item.path === location.path,
    )?.icon ??
    appearance.folderIcon ?? { kind: "preset", id: "classic" };
  const preset = selected.kind === "preset" ? selected.id : "classic";
  const color = COLORS[preset] ?? "rgb(var(--otk-accent))";
  const glyph =
    preset === "soft" ? (
      <svg viewBox="0 0 64 64" className="size-full" fill="none">
        <path d="M7 16a5 5 0 0 1 5-5h13l7 7h20a5 5 0 0 1 5 5v27H7z" fill={color} opacity=".7" />
        <path
          d="M7 27a5 5 0 0 1 5-5h40a5 5 0 0 1 5 5v22a5 5 0 0 1-5 5H12a5 5 0 0 1-5-5z"
          fill={color}
        />
        <path
          d="M12 25h40"
          stroke="white"
          strokeOpacity=".35"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    ) : (
      <Folder
        strokeWidth={preset === "outline" ? 1.6 : 1.15}
        className="size-full"
        style={{
          color,
          fill: preset === "outline" ? "none" : color,
          fillOpacity: preset === "classic" ? 0.32 : 0.6,
        }}
      />
    );
  return (
    <span
      aria-hidden
      className={
        className
          ? `relative inline-grid shrink-0 place-items-center ${className}`
          : "relative inline-grid shrink-0 place-items-center"
      }
      style={{ width: size, height: size }}
      data-folder-icon={selected.kind === "preset" ? selected.id : "uploaded"}
    >
      {selected.kind === "uploaded" ? (
        <UploadedIcon key={selected.iconId} id={selected.iconId} fallback={glyph} />
      ) : (
        glyph
      )}
      {Badge && selected.kind === "preset" ? (
        <Badge
          className="absolute left-1/2 top-[57%] -translate-x-1/2 -translate-y-1/2"
          strokeWidth={1.8}
          style={{
            width: size * 0.34,
            height: size * 0.34,
            color: "rgb(var(--otk-accent-strong))",
          }}
        />
      ) : null}
    </span>
  );
}
