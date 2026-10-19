import { SUPPORTED_LOCALES, type Locale, type PublicUser } from "@everyos/shared";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "../../../components/ui/alert.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Field } from "../../../components/ui/field.tsx";
import { Select } from "../../../components/ui/select.tsx";
import { api } from "../../../lib/api.ts";
import { errorMessage } from "../../../lib/errors.ts";
import { useSessionStore } from "../../../stores/session-store.ts";
import { LinuxAccountSection } from "../../../features/account/linux-account.tsx";
import { SettingsGroup } from "./group.tsx";

export default function AccountSection() {
  const { t } = useTranslation();
  const user = useSessionStore((state) => state.session?.user);
  const updateUser = useSessionStore((state) => state.updateUser);
  const [displayName, setDisplayName] = useState(user?.displayName ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  if (!user) return null;

  const save = async (body: { displayName?: string; locale?: Locale }) => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      updateUser(await api<PublicUser>("/account", { method: "PATCH", body }));
      setSaved(true);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <SettingsGroup title={t("settings.account.profile")}>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            void save({ displayName: displayName.trim() });
          }}
        >
          <Field
            label={t("settings.account.displayName")}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            maxLength={64}
            required
          />
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <dt className="text-fg-muted">{t("settings.account.username")}</dt>
            <dd>@{user.username}</dd>
            <dt className="text-fg-muted">{t("settings.account.role")}</dt>
            <dd>{t(`roles.${user.role}`)}</dd>
          </dl>
          {saved ? <Alert tone="success">{t("common.saved")}</Alert> : null}
          {error ? <Alert tone="danger">{errorMessage(t, error)}</Alert> : null}
          <div className="flex justify-end">
            <Button
              type="submit"
              loading={busy}
              disabled={!displayName.trim() || displayName.trim() === user.displayName}
            >
              {t("common.save")}
            </Button>
          </div>
        </form>
      </SettingsGroup>
      <SettingsGroup title={t("linux.title")}>
        <LinuxAccountSection />
      </SettingsGroup>
      <SettingsGroup title={t("settings.account.language")}>
        <div className="flex flex-col gap-3">
          {user.locale !== "tr" && user.locale !== "en" ? (
            <Alert tone="info">{t("settings.account.translationNotice")}</Alert>
          ) : null}
          <Select
            label={t("settings.account.language")}
            hideLabel
            value={user.locale}
            options={SUPPORTED_LOCALES.map((locale) => ({
              value: locale,
              label: t(`languages.${locale}`),
            }))}
            onChange={(locale) => void save({ locale })}
          />
        </div>
      </SettingsGroup>
    </div>
  );
}
