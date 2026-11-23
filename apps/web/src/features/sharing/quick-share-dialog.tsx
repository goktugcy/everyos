import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { renderSVG } from "uqr";
import { Dialog } from "../../components/ui/dialog.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Field, PasswordField } from "../../components/ui/field.tsx";
import { Alert } from "../../components/ui/alert.tsx";
import { api } from "../../lib/api.ts";
import { errorMessage } from "../../lib/errors.ts";
import { Check } from "./forms.tsx";
import { LocationPicker } from "../drive/pickers.tsx";
import type { FileLocation } from "../../desktop/apps/files/lib.ts";
import { filesChanged } from "../../desktop/apps/files/lib.ts";

export interface QuickShareRequest {
  direction: "send" | "receive";
  location: FileLocation;
  paths: string[];
}
export function QuickShareDialog({
  request,
  onClose,
  onSaved,
}: {
  request: QuickShareRequest;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(request.paths[0]?.split("/").at(-1) ?? t("sharing.quickShare"));
  const [folder, setFolder] = useState(request.location);
  const [picking, setPicking] = useState(false);
  const [lifetime, setLifetime] = useState(15);
  const [oneTime, setOneTime] = useState(false);
  const [password, setPassword] = useState("");
  const [downloads, setDownloads] = useState(10);
  const [maxBytes, setMaxBytes] = useState(1024 ** 3);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null);
  const [copied, setCopied] = useState(false);
  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ url: string }>("/sharing/quick", {
        method: "POST",
        body: {
          name,
          direction: request.direction,
          ...folder,
          paths: request.paths,
          lifetimeMinutes: lifetime,
          oneTime,
          ...(password ? { password } : {}),
          maxDownloads: downloads,
          maxBytes,
        },
      });
      setUrl(result.url);
      setPassword("");
      onSaved?.();
      filesChanged();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Dialog
        open
        onOpenChange={(v) => {
          if (!v && !busy) onClose();
        }}
        title={request.direction === "send" ? t("sharing.send") : t("sharing.receive")}
      >
        {url ? (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-fg-muted">{t("sharing.qrHint")}</p>
            <div
              className="mx-auto w-56 max-w-full rounded-everyos-md bg-white p-3 [&_svg]:h-auto [&_svg]:w-full"
              role="img"
              aria-label={t("sharing.quickShare")}
              dangerouslySetInnerHTML={{ __html: renderSVG(url) }}
            />
            <Field
              label={t("sharing.copyLink")}
              readOnly
              value={url}
              onFocus={(e) => e.target.select()}
            />
            <Button
              onClick={() =>
                void navigator.clipboard
                  .writeText(url)
                  .then(() => setCopied(true))
                  .catch(setError)
              }
            >
              {copied ? t("common.copied") : t("sharing.copyLink")}
            </Button>
            {error ? <Alert tone="danger">{errorMessage(t, error)}</Alert> : null}
            <Alert tone="info">{t("sharing.privateHint")}</Alert>
          </div>
        ) : (
          <form onSubmit={(e) => void create(e)} className="flex flex-col gap-4">
            {error ? <Alert tone="danger">{errorMessage(t, error)}</Alert> : null}
            <Alert tone="info">{t("sharing.privateHint")}</Alert>
            <Field
              label={t("sharing.name")}
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={80}
            />
            <code className="break-all text-xs text-fg-muted">
              {folder.root}:{folder.path || "/"}
            </code>
            {request.direction === "receive" ? (
              <Button variant="secondary" onClick={() => setPicking(true)}>
                {t("sharing.selectFolder")}
              </Button>
            ) : (
              <p className="text-xs text-fg-subtle">{t("sharing.sendFolderHint")}</p>
            )}
            <Field
              label={t("sharing.lifetime") + " (" + t("sharing.minutes") + ")"}
              type="number"
              min={1}
              max={1440}
              value={lifetime}
              onChange={(e) => setLifetime(Number(e.target.value))}
              required
            />
            <PasswordField
              label={t("sharing.password") + " · " + t("sharing.optional")}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={8}
              autoComplete="new-password"
            />
            <Check label={t("sharing.oneTime")} value={oneTime} onChange={setOneTime} />
            {request.direction === "send" ? (
              <Field
                label={t("sharing.maxDownloads")}
                type="number"
                min={1}
                max={1000}
                value={downloads}
                onChange={(e) => setDownloads(Number(e.target.value))}
                disabled={oneTime}
                required
              />
            ) : (
              <Field
                label={t("sharing.maxBytes")}
                type="number"
                min={1}
                max={16 * 1024 ** 3}
                value={maxBytes}
                onChange={(e) => setMaxBytes(Number(e.target.value))}
                required
              />
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" loading={busy}>
                {t("sharing.createLink")}
              </Button>
            </div>
          </form>
        )}
      </Dialog>
      {picking ? (
        <LocationPicker
          title={t("sharing.selectFolder")}
          confirmLabel={t("common.open")}
          onClose={() => setPicking(false)}
          onPick={(value) => {
            setFolder(value);
            setPicking(false);
          }}
        />
      ) : null}
    </>
  );
}
