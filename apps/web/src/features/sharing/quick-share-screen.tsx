import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { isErrorCode } from "@everyos/shared";
import { Download, Share2, Upload } from "lucide-react";
import { Button } from "../../components/ui/button.tsx";
import { PasswordField } from "../../components/ui/field.tsx";
import { Alert } from "../../components/ui/alert.tsx";
import { ApiRequestError } from "../../lib/api.ts";
import { errorMessage } from "../../lib/errors.ts";
import { formatBytes, formatDateTime } from "../../lib/format.ts";

interface Metadata {
  id: string;
  name: string;
  direction: "send" | "receive";
  expiresAt: number;
  maxBytes: number;
  bytesReceived: number;
  entries: Array<{ index: number; name: string; size: number }>;
}
async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch("/api/quick-share" + path, {
    ...options,
    credentials: "same-origin",
    cache: "no-store",
  });
  const data = (await response.json()) as { error?: { code?: string; message?: string } };
  if (!response.ok)
    throw new ApiRequestError(
      response.status,
      isErrorCode(data.error?.code) ? data.error.code : "UNKNOWN",
      data.error?.message ?? "",
    );
  return data as T;
}
/** A capability-scoped page: the desktop, account session and Files module are not loaded. */
export default function QuickShareScreen() {
  const { t, i18n } = useTranslation();
  const [raw] = useState(() => window.location.hash.slice(1));
  const [password, setPassword] = useState(""),
    [grant, setGrant] = useState("");
  const [data, setData] = useState<Metadata | null>(null),
    [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false),
    [progress, setProgress] = useState<{ name: string; bytes: number; total: number } | null>(null);
  const [complete, setComplete] = useState(false);
  const xhr = useRef<XMLHttpRequest | null>(null),
    picker = useRef<HTMLInputElement>(null);
  useEffect(
    () => () => {
      xhr.current?.abort();
    },
    [],
  );
  const open = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const access = await request<{ id: string; grant: string }>("/access", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + raw },
        body: JSON.stringify(password ? { password } : {}),
      });
      setPassword("");
      setGrant(access.grant);
      setData(await request<Metadata>("/" + access.id));
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };
  const upload = async (files: FileList | null) => {
    if (!data || !files?.length) return;
    setBusy(true);
    setError(null);
    setComplete(false);
    try {
      for (const file of Array.from(files)) {
        await new Promise<void>((resolve, reject) => {
          const current = new XMLHttpRequest();
          xhr.current = current;
          current.open(
            "POST",
            "/api/quick-share/" + data.id + "/upload?name=" + encodeURIComponent(file.name),
          );
          current.setRequestHeader("Content-Type", "application/octet-stream");
          current.setRequestHeader("X-EveryOS-Quick-Grant", grant);
          current.upload.onprogress = (e) =>
            setProgress({
              name: file.name,
              bytes: e.loaded,
              total: e.lengthComputable ? e.total : file.size,
            });
          current.onload = () => {
            if (current.status === 201) {
              resolve();
              return;
            }
            let code = "UNKNOWN";
            try {
              code = (JSON.parse(current.responseText) as { error: { code: string } }).error.code;
            } catch {
              /* Static fallback. */
            }
            reject(new ApiRequestError(current.status, isErrorCode(code) ? code : "UNKNOWN", ""));
          };
          current.onerror = () => reject(new ApiRequestError(0, "NETWORK", ""));
          current.onabort = () => reject(new ApiRequestError(409, "CANCELLED", ""));
          current.send(file);
        });
      }
      setComplete(true);
      setData(await request<Metadata>("/" + data.id));
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
      setProgress(null);
      xhr.current = null;
      if (picker.current) picker.current.value = "";
    }
  };
  return (
    <main className="flex min-h-dvh flex-col items-center bg-desktop px-4 py-10 text-fg">
      <section className="glass-strong flex w-full max-w-xl flex-col gap-5 rounded-everyos-lg p-5 sm:p-8">
        <header className="flex items-center gap-3">
          <Share2 className="size-7 shrink-0 text-accent" aria-hidden />
          <div>
            <p className="text-xs font-medium tracking-wide text-fg-subtle">EveryOS</p>
            <h1 className="break-words text-2xl font-semibold">
              {data?.name ?? t("sharing.quickShare")}
            </h1>
          </div>
        </header>
        {error ? <Alert tone="danger">{errorMessage(t, error)}</Alert> : null}
        {!data ? (
          <form onSubmit={(e) => void open(e)} className="flex flex-col gap-4">
            <p className="text-sm leading-relaxed text-fg-muted">{t("sharing.qrHint")}</p>
            <PasswordField
              label={t("sharing.password") + " · " + t("sharing.optional")}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="off"
            />
            <Button type="submit" loading={busy} disabled={!/^[A-Za-z0-9_-]{43}$/.test(raw)}>
              {t("common.open")}
            </Button>
          </form>
        ) : (
          <>
            <p className="text-xs text-fg-subtle">
              {t("sharing.expires")}: {formatDateTime(data.expiresAt, i18n.language)}
            </p>
            {data.direction === "send" ? (
              <ul className="flex flex-col gap-2">
                {data.entries.map((item) => (
                  <li key={item.index}>
                    <a
                      className="flex items-center justify-between gap-3 rounded-everyos-md border border-line px-3 py-4 text-sm outline-none hover:bg-hover/8 focus-visible:ring-2 focus-visible:ring-accent"
                      href={"/api/quick-share/" + data.id + "/download/" + item.index}
                      download={item.name}
                    >
                      <span className="min-w-0 break-words">
                        {item.name}
                        <span className="mt-1 block text-xs text-fg-subtle">
                          {formatBytes(item.size, i18n.language)}
                        </span>
                      </span>
                      <Download
                        className="size-5 shrink-0 text-accent"
                        aria-label={t("files.menu.download")}
                      />
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              <>
                <p className="text-sm text-fg-muted">
                  {formatBytes(data.bytesReceived, i18n.language)} /{" "}
                  {formatBytes(data.maxBytes, i18n.language)}
                </p>
                <input
                  ref={picker}
                  type="file"
                  multiple
                  className="sr-only"
                  tabIndex={-1}
                  onChange={(e) => void upload(e.target.files)}
                  aria-label={t("sharing.chooseFiles")}
                />
                <Button onClick={() => picker.current?.click()} loading={busy}>
                  <Upload className="size-4" aria-hidden />
                  {t("sharing.chooseFiles")}
                </Button>
                {progress ? (
                  <div aria-live="polite" className="flex flex-col gap-2">
                    <span className="break-all text-sm">{progress.name}</span>
                    <progress
                      className="h-2 w-full accent-[rgb(var(--everyos-accent))]"
                      value={progress.bytes}
                      max={progress.total || 1}
                      aria-label={progress.name}
                    />
                    <span className="text-xs text-fg-muted">
                      {formatBytes(progress.bytes, i18n.language)} /{" "}
                      {formatBytes(progress.total, i18n.language)}
                    </span>
                    <Button variant="secondary" onClick={() => xhr.current?.abort()}>
                      {t("common.cancel")}
                    </Button>
                  </div>
                ) : null}
                {complete ? <Alert tone="info">{t("sharing.uploaded")}</Alert> : null}
              </>
            )}
          </>
        )}
        <p className="text-xs leading-relaxed text-fg-subtle">{t("sharing.privateHint")}</p>
      </section>
    </main>
  );
}
