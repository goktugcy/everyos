import type { WallpaperSpec } from "@everyos/shared";
import { toTriplet, WALLPAPER_PRESETS, type WallpaperPreset } from "@everyos/theme";
import { memo, useState, type CSSProperties } from "react";
import { cn } from "../../lib/cn.ts";

const STARS =
  "radial-gradient(1px 1px at 12% 18%, #fff8, transparent), radial-gradient(1px 1px at 72% 12%, #fff9, transparent), radial-gradient(1.5px 1.5px at 38% 8%, #fffa, transparent), radial-gradient(1px 1px at 86% 30%, #fff7, transparent), radial-gradient(1px 1px at 54% 22%, #fff6, transparent), radial-gradient(1px 1px at 24% 34%, #fff5, transparent), radial-gradient(1px 1px at 92% 8%, #fff6, transparent)";

function glow(color: string, alpha: number): CSSProperties {
  return {
    background: `radial-gradient(closest-side, rgb(${toTriplet(color)} / ${alpha}), transparent)`,
  };
}

function Ridges({ tone, base }: { tone: "dark" | "light"; base: string }) {
  const far =
    tone === "dark" ? ["#3b4a7a", 0.5, "#0b1226", 0.9] : ["#ffffff", 0.55, "#c7d6ea", 0.85];
  const near = tone === "dark" ? ["#1a2346", 1, "#060914", 1] : ["#b4c6df", 0.9, "#9fb3d0", 1];
  const id = `ridge-${tone}-${base.slice(1)}`;
  return (
    <svg
      className="absolute inset-x-0 bottom-0 h-[42vh] w-full"
      viewBox="0 0 1440 420"
      preserveAspectRatio="none"
    >
      <defs>
        <linearGradient id={`${id}-far`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={far[0] as string} stopOpacity={far[1]} />
          <stop offset="1" stopColor={far[2] as string} stopOpacity={far[3]} />
        </linearGradient>
        <linearGradient id={`${id}-near`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={near[0] as string} stopOpacity={near[1]} />
          <stop offset="1" stopColor={near[2] as string} stopOpacity={near[3]} />
        </linearGradient>
      </defs>
      <path
        d="M0 260 L120 190 L210 230 L330 140 L430 205 L560 110 L690 200 L800 150 L930 225 L1050 130 L1170 200 L1290 160 L1440 220 L1440 420 L0 420 Z"
        fill={`url(#${id}-far)`}
      />
      <path
        d="M0 330 L150 260 L260 300 L400 230 L520 290 L640 220 L760 300 L900 250 L1030 310 L1160 245 L1300 300 L1440 270 L1440 420 L0 420 Z"
        fill={`url(#${id}-near)`}
      />
    </svg>
  );
}

function PresetLayers({ preset }: { preset: WallpaperPreset }) {
  const { colors, glow: alpha } = preset;
  const dark = preset.scheme === "dark";
  return (
    <>
      {preset.style === "aurora" ? (
        <>
          <div
            className="everyos-aurora-blob absolute -left-[10%] top-[-20%] h-[70vh] w-[120vw] rotate-[-8deg] opacity-70"
            style={{
              background: `linear-gradient(180deg, transparent, rgb(${toTriplet(colors.a)} / ${alpha}) 45%, transparent)`,
            }}
          />
          <div
            className="everyos-aurora-blob absolute -right-[10%] top-[-5%] h-[60vh] w-[110vw] rotate-[6deg] opacity-60 [animation-delay:-20s]"
            style={{
              background: `linear-gradient(180deg, transparent, rgb(${toTriplet(colors.b)} / ${alpha}) 50%, transparent)`,
            }}
          />
          <div
            className="everyos-aurora-blob absolute left-[15%] top-[10%] h-[50vh] w-[70vw] opacity-40 [animation-delay:-34s]"
            style={glow(colors.c, alpha)}
          />
        </>
      ) : preset.style === "flat" ? (
        <div
          className="absolute inset-0"
          style={{
            background: `radial-gradient(ellipse at 20% 0%, ${colors.b}, transparent 60%), radial-gradient(ellipse at 90% 100%, ${colors.a}, transparent 55%)`,
          }}
        />
      ) : (
        <>
          <div
            className="everyos-aurora-blob absolute -left-[20%] -top-[30%] h-[85vh] w-[85vw] rounded-full opacity-70"
            style={glow(colors.a, alpha)}
          />
          <div
            className="everyos-aurora-blob absolute -right-[25%] -top-[10%] h-[80vh] w-[75vw] rounded-full opacity-65 [animation-delay:-16s]"
            style={glow(colors.b, alpha)}
          />
          <div
            className="everyos-aurora-blob absolute left-[20%] top-[25%] h-[60vh] w-[60vw] rounded-full opacity-45 [animation-delay:-32s]"
            style={glow(colors.c, alpha)}
          />
        </>
      )}
      {dark && preset.style !== "flat" ? (
        <div className="absolute inset-0 opacity-60" style={{ backgroundImage: STARS }} />
      ) : null}
      {preset.ridges ? <Ridges tone={preset.ridges} base={colors.base} /> : null}
      {dark ? (
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_40%,rgb(0_0_0/0.45))]" />
      ) : null}
    </>
  );
}

/**
 * Renders any wallpaper specification. Built-in wallpapers are pure CSS;
 * uploaded images load from the authenticated wallpaper endpoint and fall
 * back to `fallback` if they cannot be shown.
 */
export const WallpaperView = memo(function WallpaperView({
  spec,
  fallback,
  className,
}: {
  spec: WallpaperSpec;
  fallback?: WallpaperSpec;
  className?: string;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const effective =
    spec.kind === "image" && failed === spec.wallpaperId
      ? (fallback ?? { kind: "preset", id: "everyos-dusk" })
      : spec;

  let content;
  let base = "#070b18";
  switch (effective.kind) {
    case "preset": {
      const preset = WALLPAPER_PRESETS[effective.id];
      base = preset.colors.base;
      content = <PresetLayers preset={preset} />;
      break;
    }
    case "gradient":
      base = effective.from;
      content = (
        <div
          className="absolute inset-0"
          style={{
            background: `linear-gradient(${effective.angle}deg, ${effective.from}, ${effective.to})`,
          }}
        />
      );
      break;
    case "solid":
      base = effective.color;
      break;
    case "image":
      base = "#000000";
      content = (
        <img
          src={`/api/wallpapers/${encodeURIComponent(effective.wallpaperId)}/image`}
          alt=""
          draggable={false}
          onError={() => setFailed(effective.wallpaperId)}
          className={cn(
            "absolute inset-0 size-full select-none",
            effective.fit === "cover" ? "object-cover" : "object-contain",
          )}
        />
      );
      break;
  }

  return (
    <div
      aria-hidden
      className={cn("pointer-events-none absolute inset-0 overflow-hidden", className)}
      style={{ background: base }}
    >
      {content}
    </div>
  );
});
