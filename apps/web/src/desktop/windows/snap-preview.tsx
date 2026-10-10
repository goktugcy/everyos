import type { Rect } from "@otuken/window-manager";
import { create } from "zustand";

/** The snap target shown while dragging a window (null when none). */
export const useSnapPreview = create<{ rect: Rect | null }>()(() => ({ rect: null }));

export function setSnapPreview(rect: Rect | null): void {
  const current = useSnapPreview.getState().rect;
  if (current === rect) return;
  if (
    current &&
    rect &&
    current.x === rect.x &&
    current.y === rect.y &&
    current.width === rect.width &&
    current.height === rect.height
  ) {
    return;
  }
  useSnapPreview.setState({ rect });
}

export function SnapPreview() {
  const rect = useSnapPreview((state) => state.rect);
  if (!rect) return null;
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute z-[5000] rounded-otk-lg border-2 border-accent/70 bg-[rgb(var(--otk-accent)/0.14)] backdrop-blur-sm transition-all duration-150"
      style={{
        transform: `translate3d(${rect.x + 6}px, ${rect.y + 6}px, 0)`,
        width: rect.width - 12,
        height: rect.height - 12,
      }}
    />
  );
}
