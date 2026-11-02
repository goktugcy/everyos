import type { DesktopAppInstallationView, DesktopAppListing } from "@everyos/shared";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../../components/ui/button.tsx";
import { Dialog } from "../../../components/ui/dialog.tsx";
import { api } from "../../../lib/api.ts";
import { LoadingBlock, ResourceError } from "../system/parts.tsx";
import { DesktopAppDialog } from "./desktop-app-dialog.tsx";
import { requestedDesktopApp, type DesktopAppRequest } from "./desktop-app-request.ts";

/** Fresh source-specific details for a file opener's installation request. */
export function RequestedAppDialog({
  request,
  onClose,
  onChanged,
}: {
  request: DesktopAppRequest;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const { appId, registryId, requestId } = request;
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{
    loading: boolean;
    error: unknown;
    target: ReturnType<typeof requestedDesktopApp>;
  }>({ loading: true, error: null, target: null });
  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    // The store may already be open with records from before the app was uninstalled.
    void Promise.all([
      api<{ apps: DesktopAppListing[] }>("/desktop-apps/catalog", { signal: controller.signal }),
      api<{ apps: DesktopAppInstallationView[] }>("/desktop-apps/installed", {
        signal: controller.signal,
      }),
    ])
      .then(([listings, installations]) => {
        if (!disposed)
          setResult({
            loading: false,
            error: null,
            target: requestedDesktopApp(
              { appId, registryId, requestId },
              listings.apps,
              installations.apps,
            ),
          });
      })
      .catch((error: unknown) => {
        if (!disposed) setResult({ loading: false, error, target: null });
      });
    return () => {
      disposed = true;
      controller.abort();
    };
  }, [appId, registryId, requestId, attempt]);
  const target = result.target;
  if (target)
    return (
      <DesktopAppDialog
        listing={target.listing}
        installation={target.installation}
        onClose={onClose}
        onChanged={(installation) => {
          onChanged();
          if (!installation) onClose();
          else setResult({ loading: false, error: null, target: { ...target, installation } });
        }}
      />
    );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t("apps.store")}
    >
      {result.loading ? (
        <LoadingBlock />
      ) : (
        <div className="flex flex-col gap-3">
          <ResourceError error={result.error} />
          {!result.error ? (
            <p role="alert" className="text-sm text-warning">
              {t("desktopApps.store.requestUnavailable")}
            </p>
          ) : null}
          <Button
            variant="secondary"
            onClick={() => {
              setResult({ loading: true, error: null, target: null });
              setAttempt((value) => value + 1);
            }}
          >
            {t("common.retry")}
          </Button>
        </div>
      )}
    </Dialog>
  );
}
