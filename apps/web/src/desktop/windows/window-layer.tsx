import { useShallow } from "zustand/react/shallow";
import { useWindowManager } from "../state/window-store.ts";
import { SnapPreview } from "./snap-preview.tsx";
import { WindowFrame } from "./window-frame.tsx";

/**
 * Renders every window in a stable DOM order (creation order) and expresses
 * stacking only through z-index, so focusing a window never moves DOM nodes
 * (which would blur inputs inside other windows).
 */
export function WindowLayer() {
  const ids = useWindowManager(useShallow((state) => Object.keys(state.windows)));
  const ranks = useWindowManager(
    useShallow((state) => {
      const sorted = Object.values(state.windows).sort((a, b) => a.z - b.z);
      return sorted.map((window) => window.id).join(",");
    }),
  );
  const rank = new Map(ranks.split(",").map((id, index) => [id, index]));

  return (
    <div className="pointer-events-none absolute inset-0 z-20" data-testid="window-layer">
      {ids.map((id) => (
        <WindowFrame key={id} id={id} zIndex={100 + (rank.get(id) ?? 0)} />
      ))}
      <SnapPreview />
    </div>
  );
}
