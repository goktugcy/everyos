import { useThemeStore } from "../../desktop/theme/theme-store.ts";
import { WallpaperView } from "../../desktop/wallpaper/wallpaper-view.tsx";

/** Full-screen wallpaper of the current theme (used by sign-in and setup screens). */
export function Wallpaper() {
  const theme = useThemeStore((state) => state.theme);
  const spec =
    theme.wallpaper.kind === "image"
      ? { kind: "preset" as const, id: "otuken-dusk" as const }
      : theme.wallpaper;
  return (
    <div className="fixed inset-0 -z-10">
      <WallpaperView spec={spec} />
    </div>
  );
}
