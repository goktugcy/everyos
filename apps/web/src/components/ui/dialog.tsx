import { X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn.ts";

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  className,
  overlayClassName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
  overlayClassName?: string;
}) {
  const { t } = useTranslation();
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn("fixed inset-0 z-40 bg-black/45 backdrop-blur-[2px]", overlayClassName)}
        />
        <DialogPrimitive.Content
          className={cn(
            "glass-strong otk-enter fixed left-1/2 top-1/2 z-50 flex max-h-[min(88dvh,760px)] w-[min(94vw,560px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-otk-lg",
            className,
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-line px-6 pb-4 pt-5">
            <div className="flex flex-col gap-1">
              <DialogPrimitive.Title className="text-lg font-semibold tracking-tight">
                {title}
              </DialogPrimitive.Title>
              {description ? (
                <DialogPrimitive.Description className="text-sm text-fg-muted">
                  {description}
                </DialogPrimitive.Description>
              ) : (
                <DialogPrimitive.Description className="sr-only">
                  {title}
                </DialogPrimitive.Description>
              )}
            </div>
            <DialogPrimitive.Close
              className="grid size-8 place-items-center rounded-otk-sm text-fg-subtle hover:bg-hover/8 hover:text-fg"
              aria-label={t("common.close")}
            >
              <X className="size-4" aria-hidden />
            </DialogPrimitive.Close>
          </div>
          <div className="overflow-y-auto px-6 py-5">{children}</div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
