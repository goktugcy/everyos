import { memo } from "react";

/**
 * Default "Ötüken Dusk" wallpaper: a night sky with a slow aurora above
 * layered mountain ridges. Only cheap radial gradients are animated (via
 * transform), so the GPU cost stays negligible; animation stops entirely
 * under prefers-reduced-motion and in the performance render preset.
 */
export const Wallpaper = memo(function Wallpaper() {
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 -z-10 overflow-hidden bg-[var(--otk-wallpaper-base)]"
    >
      <div
        className="otk-aurora-blob absolute -left-[20%] -top-[30%] h-[85vh] w-[85vw] rounded-full opacity-60"
        style={{
          background:
            "radial-gradient(closest-side, rgb(var(--otk-wallpaper-a) / 0.55), transparent)",
        }}
      />
      <div
        className="otk-aurora-blob absolute -right-[25%] -top-[10%] h-[80vh] w-[75vw] rounded-full opacity-55 [animation-delay:-16s]"
        style={{
          background:
            "radial-gradient(closest-side, rgb(var(--otk-wallpaper-b) / 0.55), transparent)",
        }}
      />
      <div
        className="otk-aurora-blob absolute left-[20%] top-[25%] h-[60vh] w-[60vw] rounded-full opacity-35 [animation-delay:-32s]"
        style={{
          background:
            "radial-gradient(closest-side, rgb(var(--otk-wallpaper-c) / 0.45), transparent)",
        }}
      />
      <div
        className="absolute inset-0 opacity-60"
        style={{
          backgroundImage:
            "radial-gradient(1px 1px at 12% 18%, #fff8, transparent), radial-gradient(1px 1px at 72% 12%, #fff9, transparent), radial-gradient(1.5px 1.5px at 38% 8%, #fffa, transparent), radial-gradient(1px 1px at 86% 30%, #fff7, transparent), radial-gradient(1px 1px at 54% 22%, #fff6, transparent), radial-gradient(1px 1px at 24% 34%, #fff5, transparent)",
        }}
      />
      <svg
        className="absolute inset-x-0 bottom-0 h-[42vh] w-full"
        viewBox="0 0 1440 420"
        preserveAspectRatio="none"
      >
        <defs>
          <linearGradient id="otk-ridge-far" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#3b4a7a" stopOpacity="0.55" />
            <stop offset="1" stopColor="#0b1226" stopOpacity="0.9" />
          </linearGradient>
          <linearGradient id="otk-ridge-near" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#1a2346" />
            <stop offset="1" stopColor="#060914" />
          </linearGradient>
        </defs>
        <path
          d="M0 260 L120 190 L210 230 L330 140 L430 205 L560 110 L690 200 L800 150 L930 225 L1050 130 L1170 200 L1290 160 L1440 220 L1440 420 L0 420 Z"
          fill="url(#otk-ridge-far)"
        />
        <path
          d="M0 330 L150 260 L260 300 L400 230 L520 290 L640 220 L760 300 L900 250 L1030 310 L1160 245 L1300 300 L1440 270 L1440 420 L0 420 Z"
          fill="url(#otk-ridge-near)"
        />
      </svg>
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_40%,rgb(0_0_0/0.45))]" />
    </div>
  );
});
