import { Tabs } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "../../lib/cn.ts";

/** Keep pointer selection distinct from keyboard focus after programmatic window focus. */
export function TabsList({
  className,
  onPointerDownCapture,
  onKeyDownCapture,
  onBlurCapture,
  ...props
}: ComponentProps<typeof Tabs.List>) {
  return (
    <Tabs.List
      {...props}
      className={cn("everyos-tab-list", className)}
      onPointerDownCapture={(event) => {
        event.currentTarget.dataset.pointerFocus = "";
        onPointerDownCapture?.(event);
      }}
      onKeyDownCapture={(event) => {
        delete event.currentTarget.dataset.pointerFocus;
        onKeyDownCapture?.(event);
      }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          delete event.currentTarget.dataset.pointerFocus;
        onBlurCapture?.(event);
      }}
    />
  );
}
