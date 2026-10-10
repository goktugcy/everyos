import { cn } from "../../lib/cn.ts";
import type { DesktopAppManifest } from "./types.ts";

/** Rounded gradient tile with the app's glyph. Size follows `size` (px). */
export function AppIcon({
  manifest,
  size = 40,
  className,
}: {
  manifest: Pick<DesktopAppManifest, "icon" | "tint">;
  size?: number;
  className?: string;
}) {
  const Icon = manifest.icon;
  return (
    <span
      aria-hidden
      className={cn(
        "grid shrink-0 place-items-center bg-gradient-to-br text-white shadow-[0_8px_20px_-8px_rgb(0_0_0/0.6),inset_0_1px_0_rgb(255_255_255/0.35)]",
        manifest.tint,
        className,
      )}
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.28) }}
    >
      <Icon style={{ width: size * 0.52, height: size * 0.52 }} strokeWidth={1.9} />
    </span>
  );
}
