import { useEffect, useId, useRef, type ReactNode } from "react";

/**
 * A dialog inside the app window (for forms: rename, new folder …). Confirmations of destructive
 * actions use `app.dialogs.confirm`, which EveryOS draws over the window.
 */
export function Dialog({
  open,
  title,
  onClose,
  children,
  actions,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  actions?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    } else if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="eui-dialog"
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      {open ? (
        <div className="eui-dialog-body">
          <h2 id={titleId} className="eui-dialog-title">
            {title}
          </h2>
          {children}
          {actions ? <div className="eui-dialog-actions">{actions}</div> : null}
        </div>
      ) : null}
    </dialog>
  );
}
