import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button.tsx";

export type PendingDialog =
  | { id: number; kind: "alert"; title: string; message: string; resolve: (value: null) => void }
  | {
      id: number;
      kind: "confirm";
      title: string;
      message: string;
      confirm: string | null;
      destructive: boolean;
      resolve: (value: boolean) => void;
    }
  | {
      id: number;
      kind: "prompt";
      title: string;
      message: string;
      value: string;
      placeholder: string | null;
      resolve: (value: string | null) => void;
    };

/**
 * A dialog an app asked for, drawn by the desktop over the app's own window (never over other
 * windows). Its texts come from the app and are shown as text only.
 */
export function AppDialog({ dialog, appName }: { dialog: PendingDialog; appName: string }) {
  const { t } = useTranslation();
  const [value, setValue] = useState(dialog.kind === "prompt" ? dialog.value : "");
  const input = useRef<HTMLInputElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    (dialog.kind === "prompt" ? input.current : primary.current)?.focus();
  }, [dialog]);
  const cancel = () => {
    if (dialog.kind === "alert") dialog.resolve(null);
    else if (dialog.kind === "confirm") dialog.resolve(false);
    else dialog.resolve(null);
  };
  const accept = () => {
    if (dialog.kind === "alert") dialog.resolve(null);
    else if (dialog.kind === "confirm") dialog.resolve(true);
    else dialog.resolve(value);
  };
  return (
    <div
      className="absolute inset-0 z-20 grid place-items-center bg-black/30 p-4"
      onKeyDown={(event) => {
        if (event.key === "Escape") cancel();
      }}
    >
      <form
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`app-dialog-${dialog.id}`}
        className="glass-strong flex w-full max-w-sm flex-col gap-3 rounded-everyos-lg p-5"
        onSubmit={(event) => {
          event.preventDefault();
          accept();
        }}
      >
        <p className="text-[0.7rem] font-medium uppercase tracking-wider text-fg-subtle">
          {appName}
        </p>
        <h2 id={`app-dialog-${dialog.id}`} className="text-base font-semibold text-fg">
          {dialog.title}
        </h2>
        {dialog.message ? (
          <p className="whitespace-pre-wrap text-sm text-fg-muted">{dialog.message}</p>
        ) : null}
        {dialog.kind === "prompt" ? (
          <input
            ref={input}
            value={value}
            placeholder={dialog.placeholder ?? undefined}
            onChange={(event) => setValue(event.target.value.slice(0, 1000))}
            className="glass-inset h-9 rounded-everyos-md px-3 text-sm text-fg outline-none focus-visible:ring-2 focus-visible:ring-accent"
          />
        ) : null}
        <div className="flex justify-end gap-2 pt-1">
          {dialog.kind !== "alert" ? (
            <Button type="button" variant="ghost" onClick={cancel}>
              {t("common.cancel")}
            </Button>
          ) : null}
          <Button
            ref={primary}
            type="submit"
            variant={dialog.kind === "confirm" && dialog.destructive ? "danger" : "primary"}
          >
            {dialog.kind === "confirm" && dialog.confirm
              ? dialog.confirm
              : dialog.kind === "alert"
                ? t("common.close")
                : t("common.confirm")}
          </Button>
        </div>
      </form>
    </div>
  );
}
