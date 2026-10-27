import { useT } from "@everyos/app-ui";
import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { hsvToRgb, rgbToHsv, toHex, type Hsv, type Rgb } from "./color.ts";

/*
 * The picker: a saturation/value square, a hue slider and an alpha slider. Each works with the
 * pointer and with the keyboard (arrows, Shift for bigger steps), and announces its value.
 */

function drag(event: PointerEvent<HTMLElement>, apply: (x: number, y: number) => void) {
  const element = event.currentTarget;
  const move = (clientX: number, clientY: number) => {
    const rect = element.getBoundingClientRect();
    const x = rect.width ? Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) : 0;
    const y = rect.height ? Math.min(1, Math.max(0, (clientY - rect.top) / rect.height)) : 0;
    apply(x, y);
  };
  element.setPointerCapture?.(event.pointerId);
  move(event.clientX, event.clientY);
  const onMove = (next: globalThis.PointerEvent) => move(next.clientX, next.clientY);
  const onUp = () => {
    element.removeEventListener("pointermove", onMove);
    element.removeEventListener("pointerup", onUp);
  };
  element.addEventListener("pointermove", onMove);
  element.addEventListener("pointerup", onUp);
}

export function Picker({ color, onChange }: { color: Rgb; onChange: (color: Rgb) => void }) {
  const t = useT();
  // Hue and saturation are kept while the color is gray or black (where they are undefined).
  const last = useRef<Hsv>(rgbToHsv(color));
  const hsv = rgbToHsv(color);
  if (hsv.s > 0 && hsv.v > 0) last.current = hsv;
  else last.current = { ...last.current, v: hsv.v, s: hsv.v > 0 ? hsv.s : last.current.s };
  const { h, s, v } = last.current;
  const set = (next: Partial<Hsv>, alpha = color.a) => {
    last.current = { ...last.current, ...next };
    onChange(hsvToRgb(last.current, alpha));
  };
  const keys = (event: KeyboardEvent, handlers: Record<string, () => void>) => {
    const run = handlers[event.key];
    if (!run) return;
    event.preventDefault();
    run();
  };
  const step = (event: KeyboardEvent) => (event.shiftKey ? 10 : 1);
  const hueColor = toHex(hsvToRgb({ h, s: 100, v: 100 }), false);
  const opaque = toHex({ ...color, a: 1 }, false);

  return (
    <div className="cs-picker">
      <div
        className="cs-sv"
        role="slider"
        tabIndex={0}
        aria-label={t("picker.saturationValue")}
        aria-valuetext={t("picker.svValue", { s: Math.round(s), v: Math.round(v) })}
        style={{ backgroundColor: hueColor }}
        onPointerDown={(event) => drag(event, (x, y) => set({ s: x * 100, v: (1 - y) * 100 }))}
        onKeyDown={(event) =>
          keys(event, {
            ArrowLeft: () => set({ s: Math.max(0, s - step(event)) }),
            ArrowRight: () => set({ s: Math.min(100, s + step(event)) }),
            ArrowUp: () => set({ v: Math.min(100, v + step(event)) }),
            ArrowDown: () => set({ v: Math.max(0, v - step(event)) }),
          })
        }
      >
        <span
          className="cs-sv-thumb"
          style={{ left: `${s}%`, top: `${100 - v}%`, background: opaque }}
          aria-hidden
        />
      </div>
      <div
        className="cs-bar cs-hue"
        role="slider"
        tabIndex={0}
        aria-label={t("picker.hue")}
        aria-valuemin={0}
        aria-valuemax={360}
        aria-valuenow={Math.round(h)}
        onPointerDown={(event) => drag(event, (x) => set({ h: x * 360 }))}
        onKeyDown={(event) =>
          keys(event, {
            ArrowLeft: () => set({ h: (h - step(event) + 360) % 360 }),
            ArrowRight: () => set({ h: (h + step(event)) % 360 }),
            ArrowDown: () => set({ h: (h - step(event) + 360) % 360 }),
            ArrowUp: () => set({ h: (h + step(event)) % 360 }),
          })
        }
      >
        <span
          className="cs-bar-thumb"
          style={{ left: `${(h / 360) * 100}%`, background: hueColor }}
          aria-hidden
        />
      </div>
      <div
        className="cs-bar cs-alpha"
        role="slider"
        tabIndex={0}
        aria-label={t("picker.alpha")}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(color.a * 100)}
        style={{ "--cs-alpha-color": opaque } as React.CSSProperties}
        onPointerDown={(event) =>
          drag(event, (x) => onChange({ ...color, a: Math.round(x * 100) / 100 }))
        }
        onKeyDown={(event) =>
          keys(event, {
            ArrowLeft: () =>
              onChange({
                ...color,
                a: Math.max(0, Math.round((color.a - step(event) / 100) * 100) / 100),
              }),
            ArrowRight: () =>
              onChange({
                ...color,
                a: Math.min(1, Math.round((color.a + step(event) / 100) * 100) / 100),
              }),
            ArrowDown: () =>
              onChange({
                ...color,
                a: Math.max(0, Math.round((color.a - step(event) / 100) * 100) / 100),
              }),
            ArrowUp: () =>
              onChange({
                ...color,
                a: Math.min(1, Math.round((color.a + step(event) / 100) * 100) / 100),
              }),
          })
        }
      >
        <span
          className="cs-bar-thumb"
          style={{ left: `${color.a * 100}%`, background: toHex(color) }}
          aria-hidden
        />
      </div>
    </div>
  );
}
