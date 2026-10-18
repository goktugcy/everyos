import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AuthLayout } from "../../components/auth-layout.tsx";
import { Alert } from "../../components/ui/alert.tsx";
import { Button } from "../../components/ui/button.tsx";
import { errorMessage } from "../../lib/errors.ts";
import { LockScreen } from "../../desktop/lock/lock-screen.tsx";
import { useSessionStore } from "../../stores/session-store.ts";
import { TwoFactorSection } from "../account/account-security.tsx";

/**
 * Shown instead of the desktop while the administrator's two-factor policy covers this account
 * and it has no second factor yet; the server refuses everything else until it is set up.
 */
export function TwoFactorSetupScreen() {
  const { t } = useTranslation();
  const user = useSessionStore((state) => state.session?.user);
  const refresh = useSessionStore((state) => state.refresh);
  const signOut = useSessionStore((state) => state.signOut);
  const locked = useSessionStore((state) => state.locked);
  const [error, setError] = useState<unknown>(null);
  if (!user) return null;
  if (locked) return <LockScreen />;
  return (
    <AuthLayout title={t("twoFactorSetup.title")} subtitle={t("twoFactorSetup.subtitle")}>
      <div className="flex flex-col gap-4" data-testid="two-factor-setup">
        <TwoFactorSection
          user={user}
          onUserChange={() => {
            setError(null);
            refresh().catch(setError);
          }}
        />
        {error ? <Alert tone="danger">{errorMessage(t, error)}</Alert> : null}
        <div className="flex justify-center border-t border-border/60 pt-3">
          <Button variant="ghost" size="sm" onClick={() => void signOut()}>
            {t("shell.menu.signOut")}
          </Button>
        </div>
      </div>
    </AuthLayout>
  );
}
