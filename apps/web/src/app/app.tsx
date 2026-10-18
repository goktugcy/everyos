import { lazy, Suspense, useEffect, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { LogoMark } from "../components/brand/logo.tsx";
import { Wallpaper } from "../components/brand/wallpaper.tsx";
import { Alert } from "../components/ui/alert.tsx";
import { Button } from "../components/ui/button.tsx";
import { Spinner } from "../components/ui/spinner.tsx";
import { useSessionStore } from "../stores/session-store.ts";

// Each top-level screen is its own chunk: a signed-in user never downloads
// the setup wizard, and the login page does not ship the desktop.
const SetupScreen = lazy(() =>
  import("../features/setup/setup-screen.tsx").then((m) => ({ default: m.SetupScreen })),
);
const LoginScreen = lazy(() =>
  import("../features/auth/login-screen.tsx").then((m) => ({ default: m.LoginScreen })),
);
const TwoFactorSetupScreen = lazy(() =>
  import("../features/auth/two-factor-setup-screen.tsx").then((m) => ({
    default: m.TwoFactorSetupScreen,
  })),
);
const DesktopShell = lazy(() =>
  import("../desktop/shell/desktop-shell.tsx").then((m) => ({ default: m.DesktopShell })),
);

function Splash({ children }: { children?: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 px-4">
      <Wallpaper />
      <LogoMark className="size-16" />
      {children}
    </div>
  );
}

export function App() {
  const { t } = useTranslation();
  const loading = (
    <Splash>
      <Spinner className="size-6 text-fg-subtle" label={t("common.loading")} />
    </Splash>
  );
  return <Suspense fallback={loading}>{<Screen loading={loading} />}</Suspense>;
}

function Screen({ loading }: { loading: ReactNode }) {
  const { t } = useTranslation();
  const phase = useSessionStore((state) => state.phase);
  const boot = useSessionStore((state) => state.boot);
  const setupTwoFactor = useSessionStore((state) => state.session?.twoFactorSetupRequired ?? false);

  useEffect(() => {
    void boot();
  }, [boot]);

  switch (phase) {
    case "booting":
      return loading;
    case "unreachable":
      return (
        <Splash>
          <div className="flex w-full max-w-sm flex-col gap-4">
            <Alert tone="danger">{t("errors.NETWORK")}</Alert>
            <Button onClick={() => void boot()}>{t("common.retry")}</Button>
          </div>
        </Splash>
      );
    case "setup":
      return <SetupScreen />;
    case "login":
      return <LoginScreen />;
    case "authenticated":
      return setupTwoFactor ? <TwoFactorSetupScreen /> : <DesktopShell />;
  }
}
