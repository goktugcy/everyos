import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "../../components/ui/alert.tsx";
import { Button } from "../../components/ui/button.tsx";
import { PasswordField } from "../../components/ui/field.tsx";
import { Clock } from "../../features/shell/clock.tsx";
import { errorMessage } from "../../lib/errors.ts";
import { useSessionStore } from "../../stores/session-store.ts";
import { retryPendingSaves, usePreferences } from "../state/preferences-store.ts";
import { useThemeStore } from "../theme/theme-store.ts";
import { WallpaperView } from "../wallpaper/wallpaper-view.tsx";

/**
 * Full-screen lock. The lock itself is enforced by the API (HTTP 423 for
 * everything but unlock/logout); this screen only collects the password.
 */
export function LockScreen() {
  const { t } = useTranslation();
  const user = useSessionStore((state) => state.session?.user);
  const unlock = useSessionStore((state) => state.unlock);
  const signOut = useSessionStore((state) => state.signOut);
  const theme = useThemeStore((state) => state.theme);
  const clockSeconds = usePreferences((state) => state.menubar.clockSeconds);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => () => setPassword(""), []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await unlock(password);
      setPassword("");
      retryPendingSaves();
    } catch (caught) {
      setError(caught);
      setPassword("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal
      aria-labelledby="lock-title"
      className="fixed inset-0 z-[10000] flex items-center justify-center"
      data-testid="lock-screen"
    >
      <WallpaperView spec={theme.wallpaper} className="scale-105 blur-md" />
      <div className="absolute inset-0 bg-black/25" aria-hidden />
      <div className="everyos-enter relative flex w-[min(92vw,380px)] flex-col items-center gap-6">
        <p className="text-4xl font-light tracking-tight text-white drop-shadow-lg">
          <Clock seconds={clockSeconds} />
        </p>
        <form
          onSubmit={(event) => void submit(event)}
          className="glass-strong flex w-full flex-col gap-4 rounded-everyos-lg p-6"
        >
          <div className="flex flex-col items-center gap-2 text-center">
            <span className="grid size-14 place-items-center rounded-full button-accent text-lg font-bold">
              {user?.displayName.slice(0, 1).toLocaleUpperCase("tr")}
            </span>
            <h1 id="lock-title" className="text-lg font-semibold">
              {user?.displayName}
            </h1>
            <p className="text-sm text-fg-muted">{t("lock.subtitle")}</p>
          </div>
          <PasswordField
            label={t("lock.password")}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            autoFocus
            required
          />
          {error ? <Alert tone="danger">{errorMessage(t, error)}</Alert> : null}
          <Button type="submit" size="lg" loading={busy} disabled={!password}>
            {t("lock.unlock")}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void signOut()}>
            {t("lock.signOutInstead")}
          </Button>
        </form>
      </div>
    </div>
  );
}
