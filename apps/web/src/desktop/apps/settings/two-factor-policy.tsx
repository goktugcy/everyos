import {
  TWO_FACTOR_POLICIES,
  type TwoFactorPolicy,
  type TwoFactorPolicyView,
} from "@everyos/shared";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "../../../components/ui/alert.tsx";
import { Select } from "../../../components/ui/select.tsx";
import { api } from "../../../lib/api.ts";
import { errorMessage } from "../../../lib/errors.ts";
import { LoadingBlock } from "../system/parts.tsx";
import { SettingsGroup } from "./group.tsx";

/** Administrators: which roles must use two-factor authentication (enforced by the API). */
export function TwoFactorPolicyGroup() {
  const { t } = useTranslation();
  const [view, setView] = useState<TwoFactorPolicyView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let active = true;
    api<TwoFactorPolicyView>("/security/two-factor").then(
      (loaded) => active && setView(loaded),
      (caught: unknown) => active && setError(caught),
    );
    return () => {
      active = false;
    };
  }, []);

  const change = async (required: TwoFactorPolicy) => {
    setBusy(true);
    setError(null);
    try {
      setView(
        await api<TwoFactorPolicyView>("/security/two-factor", {
          method: "PUT",
          body: { required },
        }),
      );
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsGroup
      title={t("settings.security.twoFactorPolicy")}
      description={t("settings.security.twoFactorPolicyHint")}
    >
      {view ? (
        <>
          <Select
            label={t("settings.security.twoFactorPolicy")}
            hideLabel
            value={view.required}
            disabled={busy}
            options={TWO_FACTOR_POLICIES.map((policy) => ({
              value: policy,
              label: t(`settings.security.twoFactorPolicies.${policy}`),
            }))}
            onChange={(value) => void change(value)}
          />
          {view.pending.length > 0 ? (
            <p className="text-xs leading-relaxed text-fg-muted" data-testid="two-factor-pending">
              {t("settings.security.twoFactorPending", {
                count: view.pending.length,
                names: view.pending.map((user) => user.displayName).join(", "),
              })}
            </p>
          ) : null}
        </>
      ) : error ? null : (
        <LoadingBlock />
      )}
      {error ? <Alert tone="danger">{errorMessage(t, error)}</Alert> : null}
    </SettingsGroup>
  );
}
