import type { PowerAction, PowerActionResult, PowerBlocker } from "@everyos/shared";
import type { TFunction } from "i18next";
import { Loader2, Power, RotateCcw } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { create } from "zustand";
import { Alert } from "../../components/ui/alert.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Dialog } from "../../components/ui/dialog.tsx";
import { Field } from "../../components/ui/field.tsx";
import { SudoUnlock } from "../../features/account/sudo-unlock.tsx";
import { api, ApiRequestError } from "../../lib/api.ts";
import { errorMessage } from "../../lib/errors.ts";
import type { MenuEntry } from "../menus/menu-model.ts";

interface PowerState {
  /** The action whose confirmation dialog is open. */
  asking: PowerAction | null;
  /** An accepted action: the shell waits for the host to go down (and come back). */
  pending: PowerActionResult | null;
}

const usePower = create<PowerState>()(() => ({ asking: null, pending: null }));

export const power = {
  ask: (action: PowerAction) => usePower.setState({ asking: action }),
};

/** Restart and power-off entries for menus; the server requires `system:manage` as well. */
export function powerMenuEntries(t: TFunction): MenuEntry[] {
  return [
    {
      kind: "item",
      id: "reboot",
      label: t("hostPower.menu.reboot"),
      icon: <RotateCcw />,
      permission: "system:manage",
      onSelect: () => power.ask("reboot"),
    },
    {
      kind: "item",
      id: "shutdown",
      label: t("hostPower.menu.shutdown"),
      icon: <Power />,
      permission: "system:manage",
      onSelect: () => power.ask("shutdown"),
    },
  ];
}

/** The confirmation dialog and the waiting screen, mounted once by each shell. */
export function PowerHost() {
  const asking = usePower((state) => state.asking);
  const pending = usePower((state) => state.pending);
  return (
    <>
      {asking ? (
        <PowerDialog action={asking} onClose={() => usePower.setState({ asking: null })} />
      ) : null}
      {pending ? <PowerScreen result={pending} /> : null}
    </>
  );
}

function PowerDialog({ action, onClose }: { action: PowerAction; onClose: () => void }) {
  const { t } = useTranslation();
  const [blockers, setBlockers] = useState<PowerBlocker[] | null>(null);
  const [password, setPassword] = useState("");
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    const controller = new AbortController();
    void api<{ blockers: PowerBlocker[] }>("/system/power/blockers", {
      signal: controller.signal,
    })
      .then((result) => setBlockers(result.blockers))
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setError(caught);
      });
    return () => controller.abort();
  }, []);
  const blocked = blockers?.includes("release-install") ?? false;
  const needsForce = (blockers?.length ?? 0) > 0;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api<PowerActionResult>("/system/power", {
        method: "POST",
        body: { action, confirm: action, password, ...(needsForce ? { force } : {}) },
      });
      usePower.setState({ asking: null, pending: result });
    } catch (caught) {
      // Work that started after the dialog opened is listed, not just reported.
      const details =
        caught instanceof ApiRequestError
          ? (caught.details as { blockers?: PowerBlocker[] } | undefined)
          : undefined;
      if (details?.blockers) setBlockers(details.blockers);
      setError(caught);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t(`hostPower.${action}.title`)}
      description={t(`hostPower.${action}.description`)}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => void submit(event)}
        data-testid="power-dialog"
      >
        {blockers === null && !error ? (
          <p className="flex items-center gap-2 text-sm text-fg-muted">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            {t("hostPower.checking")}
          </p>
        ) : null}
        {blockers?.length ? (
          <Alert tone={blocked ? "danger" : "warning"} title={t("hostPower.busyTitle")}>
            <ul className="list-disc pl-4">
              {blockers.map((blocker) => (
                <li key={blocker}>{t(`hostPower.blockers.${blocker}`)}</li>
              ))}
            </ul>
            {blocked ? <p className="mt-2">{t("hostPower.releaseBlocks")}</p> : null}
          </Alert>
        ) : null}
        {blockers && !blocked && needsForce ? (
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 accent-[rgb(var(--everyos-accent))]"
              checked={force}
              onChange={(event) => setForce(event.target.checked)}
            />
            {t("hostPower.force")}
          </label>
        ) : null}
        <Field
          label={t("hostPower.password")}
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        {error ? <Alert tone="danger">{errorMessage(t, error)}</Alert> : null}
        <SudoUnlock error={error} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            type="submit"
            variant="danger"
            loading={busy}
            disabled={!password || blockers === null || blocked || (needsForce && !force)}
          >
            {t(`hostPower.${action}.confirm`)}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * Covers the shell while the host restarts or powers off. After a restart the page reloads once
 * the API answers again; a powered-off host keeps being asked, so turning it back on recovers too.
 */
function PowerScreen({ result }: { result: PowerActionResult }) {
  const { t } = useTranslation();
  const [down, setDown] = useState(false);
  useEffect(() => {
    if (result.source === "simulated") return;
    let wentDown = false;
    let timer: ReturnType<typeof setTimeout>;
    const probe = async () => {
      const up = await fetch("/api/health", { cache: "no-store" }).then(
        (response) => response.ok,
        () => false,
      );
      if (!up && Date.now() >= result.at) {
        wentDown = true;
        setDown(true);
      }
      if (up && wentDown) {
        window.location.reload();
        return;
      }
      timer = setTimeout(
        () => void probe(),
        wentDown && result.action === "shutdown" ? 10_000 : 3_000,
      );
    };
    timer = setTimeout(() => void probe(), Math.max(1_000, result.at - Date.now()));
    return () => clearTimeout(timer);
  }, [result]);
  const Icon = result.action === "reboot" ? RotateCcw : Power;
  return (
    <div
      role="alertdialog"
      aria-live="assertive"
      aria-label={t(`hostPower.${result.action}.waiting`)}
      className="fixed inset-0 z-[9500] flex flex-col items-center justify-center gap-4 bg-black/75 p-6 text-center text-white backdrop-blur-sm"
      data-testid="power-screen"
    >
      <Icon className="size-10" aria-hidden />
      <h2 className="text-xl font-semibold">
        {t(
          result.action === "shutdown" && down
            ? "hostPower.shutdown.done"
            : `hostPower.${result.action}.waiting`,
        )}
      </h2>
      <p className="max-w-md text-sm text-white/80">
        {result.source === "simulated"
          ? t("hostPower.simulated")
          : t(
              result.action === "shutdown" && down
                ? "hostPower.shutdown.doneHint"
                : `hostPower.${result.action}.hint`,
            )}
      </p>
      {result.source === "simulated" ? (
        <Button variant="secondary" onClick={() => usePower.setState({ pending: null })}>
          {t("common.close")}
        </Button>
      ) : (
        <Loader2 className="size-6 animate-spin" aria-hidden />
      )}
    </div>
  );
}
