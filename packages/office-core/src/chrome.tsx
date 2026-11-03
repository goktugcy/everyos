import { Button, LoadingState, Spacer, Toolbar, ToolbarTitle, useT } from "@everyos/app-ui";
import type { ReactNode } from "react";
import type { useOffice } from "./use-office.ts";

export function OfficeChrome({
  controller,
  children,
}: {
  controller: ReturnType<typeof useOffice>;
  children: ReactNode;
}) {
  const t = useT();
  const { document, busy, ready, error } = controller;
  return (
    <div className="office-shell">
      <div className="office-actions" data-testid="office-actions">
        <Toolbar>
          <Button disabled={busy} onClick={() => void controller.fresh()}>
            {t("office.new")}
          </Button>
          <Button disabled={busy} onClick={() => void controller.open()}>
            {t("office.open")}
          </Button>
          <Button disabled={busy || !ready} onClick={() => void controller.save()}>
            {t("office.save")}
          </Button>
          <Button disabled={busy || !ready} onClick={() => void controller.save(true)}>
            {t("office.saveAs")}
          </Button>
          <Spacer />
          <ToolbarTitle>{document?.name ?? t("office.title")}</ToolbarTitle>
        </Toolbar>
      </div>
      {document?.legacy ? (
        <p className="office-notice" role="note">
          {t("office.legacyNotice")}
        </p>
      ) : null}
      {document?.csv ? (
        <p className="office-notice" role="note">
          {t("office.csvNotice")}
        </p>
      ) : null}
      {error ? (
        <p className="office-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="office-content" inert={busy} aria-busy={busy}>
        {children}
      </div>
      {!document && busy ? <LoadingState /> : null}
      <div className="office-status" role="status">
        {error ??
          (busy || (!ready && document)
            ? t("office.working")
            : document?.dirty
              ? t("office.unsaved")
              : t("office.ready"))}
      </div>
    </div>
  );
}
