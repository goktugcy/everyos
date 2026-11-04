import type {
  LinuxBackupCapability,
  LinuxBackupPlan,
  LinuxBackupSchedule,
  LinuxBackupRetention,
} from "@everyos/shared";
import { Check, ChevronRight, FolderTree, HardDrive, ShieldCheck } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "../../../components/ui/alert.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Dialog } from "../../../components/ui/dialog.tsx";
import { Field, PasswordField, inputClassName } from "../../../components/ui/field.tsx";
import { Select } from "../../../components/ui/select.tsx";
import { SudoUnlock } from "../../../features/account/sudo-unlock.tsx";
import { api } from "../../../lib/api.ts";
import { cn } from "../../../lib/cn.ts";
import { errorMessage } from "../../../lib/errors.ts";
import { formatBytes } from "../../../lib/format.ts";

const paths = (value: string) => [
  ...new Set(
    value
      .split("\n")
      .map((p) => p.trim())
      .filter(Boolean),
  ),
];
const steps = ["contentStep", "storageStep", "scheduleStep", "reviewStep"] as const;
const pad = (value: number) => String(value).padStart(2, "0");
const keepKey = {
  hourly: "keepHourly",
  daily: "keepDaily",
  weekly: "keepWeekly",
  monthly: "keepMonthly",
} as const;

export function LinuxPlanDialog({
  capability,
  timezone,
  plan,
  onClose,
  onSaved,
}: {
  capability: LinuxBackupCapability;
  timezone: string;
  plan: LinuxBackupPlan | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [step, setStep] = useState(0);
  const [name, setName] = useState(plan?.name ?? "");
  const [scope, setScope] = useState<LinuxBackupPlan["scope"]>(plan?.scope ?? "system");
  const [includes, setIncludes] = useState(plan?.includes.join("\n") ?? "");
  const [excludes, setExcludes] = useState(plan?.excludes.join("\n") ?? "");
  const [excludeCaches, setExcludeCaches] = useState(plan?.excludeCaches ?? true);
  const [targetId, setTarget] = useState(
    plan?.targetId ?? capability.targets.find((p) => p.available)?.id ?? "",
  );
  const [encryption, setEncryption] = useState<LinuxBackupPlan["encryption"]>(
    plan?.encryption ?? "repokey-blake2",
  );
  const [compression, setCompression] = useState<LinuxBackupPlan["compression"]>(
    plan?.compression ?? "lz4",
  );
  const [passphrase, setPassphrase] = useState("");
  const [repeat, setRepeat] = useState("");
  const [password, setPassword] = useState("");
  const [consent, setConsent] = useState(false);
  const [schedule, setSchedule] = useState<LinuxBackupSchedule>(
    plan?.schedule ?? { frequency: "manual", hour: 3, minute: 0, weekday: 0, day: 1 },
  );
  const [retention, setRetention] = useState<LinuxBackupRetention>(
    plan?.retention ?? { enabled: false, hourly: 24, daily: 7, weekly: 4, monthly: 12 },
  );
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<{ paths: string[]; excludes: string[] } | null>(null);
  const [previewRevision, setPreviewRevision] = useState(0);
  const [previewError, setPreviewError] = useState<unknown>(null);
  useEffect(() => {
    if (step !== 3) return;
    let stale = false;
    void api<{ paths: string[]; excludes: string[] }>("/linux-backups/preview", {
      method: "POST",
      body: {
        scope,
        includes: scope === "custom" ? paths(includes) : [],
        excludes: paths(excludes),
        excludeCaches,
      },
    }).then(
      (value) => {
        if (!stale) setPreview(value);
      },
      (value: unknown) => {
        if (!stale) setPreviewError(value);
      },
    );
    return () => {
      stale = true;
    };
  }, [step, scope, includes, excludes, excludeCaches, previewRevision]);
  const check = (
    label: string,
    value: boolean,
    set: (v: boolean) => void,
    children?: ReactNode,
  ) => (
    <label className="flex items-start gap-3 text-sm">
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => set(e.currentTarget.checked)}
        className="mt-1 size-4 shrink-0 accent-[rgb(var(--everyos-accent-strong))]"
      />
      <span>
        {label}
        {children}
      </span>
    </label>
  );
  const area = (label: string, value: string, set: (v: string) => void) => (
    <label className="flex flex-col gap-2 text-sm">
      <span className="font-medium text-fg-muted">{label}</span>
      <textarea
        className={cn(inputClassName, "h-28 resize-y py-2 font-mono text-xs")}
        value={value}
        onChange={(e) => set(e.currentTarget.value)}
        spellCheck={false}
      />
      <span className="text-xs text-fg-subtle">{t("linuxBackups.pathsHint")}</span>
    </label>
  );
  const save = async () => {
    if (step < 3) {
      setPreview(null);
      setPreviewError(null);
      setStep(step + 1);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await api(plan ? `/linux-backups/plans/${plan.id}` : "/linux-backups/plans", {
        method: plan ? "PUT" : "POST",
        body: {
          name,
          scope,
          includes: scope === "custom" ? paths(includes) : [],
          excludes: paths(excludes),
          excludeCaches,
          targetId,
          encryption,
          compression,
          schedule,
          retention,
          password,
          unencryptedConsent: consent,
          ...(!plan && encryption !== "none" ? { passphrase } : {}),
        },
      });
      onSaved();
      onClose();
    } catch (caught) {
      setError(caught);
    } finally {
      setSaving(false);
    }
  };
  const valid =
    step === 0
      ? Boolean(name.trim() && (scope !== "custom" || paths(includes).length))
      : step === 1
        ? Boolean(
            targetId &&
            (plan || encryption === "none" || (passphrase.length >= 12 && passphrase === repeat)),
          )
        : step === 2
          ? !retention.enabled ||
            retention.hourly + retention.daily + retention.weekly + retention.monthly > 0
          : Boolean(password && preview && (encryption !== "none" || consent));
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !saving && onClose()}
      title={t(plan ? "linuxBackups.edit" : "linuxBackups.add")}
      description={t("linuxBackups.intro")}
      className="w-[min(94vw,780px)]"
    >
      <form
        className="flex flex-col gap-6"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) void save();
        }}
      >
        <ol className="grid grid-cols-4 gap-2" aria-label={t("linuxBackups.review")}>
          {steps.map((key, index) => (
            <li
              key={key}
              aria-current={step === index ? "step" : undefined}
              className={cn(
                "flex flex-col gap-2 border-t-2 pt-2 text-xs",
                step === index ? "border-accent text-accent" : "border-line text-fg-subtle",
              )}
            >
              <span className="flex items-center gap-1 font-medium">
                {step > index ? <Check className="size-3" aria-hidden /> : index + 1}
                {t(`linuxBackups.${key}`)}
              </span>
            </li>
          ))}
        </ol>
        {step === 0 ? (
          <>
            <Field
              label={t("linuxBackups.name")}
              value={name}
              maxLength={80}
              required
              onChange={(e) => setName(e.currentTarget.value)}
            />
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-2 text-sm font-medium">{t("linuxBackups.scope")}</legend>
              {(["system", "full", "custom"] as const).map((value) => (
                <label
                  key={value}
                  className={cn(
                    "flex cursor-pointer gap-3 rounded-everyos-md border p-4",
                    scope === value
                      ? "border-accent/60 bg-accent/8"
                      : "border-line hover:bg-hover/5",
                  )}
                >
                  <input
                    type="radio"
                    name="linux-backup-scope"
                    value={value}
                    checked={scope === value}
                    onChange={() => setScope(value)}
                    className="mt-1 accent-[rgb(var(--everyos-accent-strong))]"
                  />
                  <span>
                    <span className="block text-sm font-semibold">
                      {t(`linuxBackups.${value}Title`)}
                    </span>
                    <span className="mt-1 block text-xs leading-relaxed text-fg-muted">
                      {t(`linuxBackups.${value}Body`)}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>
            {scope === "custom" ? area(t("linuxBackups.includes"), includes, setIncludes) : null}
            {area(t("linuxBackups.excludes"), excludes, setExcludes)}
            {check(t("linuxBackups.caches"), excludeCaches, setExcludeCaches)}
          </>
        ) : null}
        {step === 1 ? (
          <>
            <Select
              label={t("linuxBackups.destination")}
              value={targetId}
              onChange={setTarget}
              disabled={Boolean(plan)}
              options={capability.targets
                .filter((p) => p.available || p.id === targetId)
                .map((p) => ({
                  value: p.id,
                  label: `${p.path}${p.freeBytes === null ? "" : ` · ${t("linuxBackups.free", { size: formatBytes(p.freeBytes, i18n.language) })}`}`,
                }))}
            />
            {!capability.targets.some((p) => p.available) ? (
              <Alert tone="warning">{t("linuxBackups.noTargets")}</Alert>
            ) : null}
            <Select
              label={t("linuxBackups.encryption")}
              value={encryption}
              onChange={(v) => {
                setEncryption(v);
                setConsent(false);
              }}
              disabled={Boolean(plan)}
              options={[
                { value: "repokey-blake2", label: t("linuxBackups.encrypted") },
                { value: "none", label: t("linuxBackups.plain") },
              ]}
            />
            {plan ? (
              <p className="text-xs text-fg-subtle">{t("linuxBackups.immutable")}</p>
            ) : encryption === "none" ? (
              <Alert tone="warning">{t("linuxBackups.plainWarning")}</Alert>
            ) : (
              <>
                <PasswordField
                  label={t("linuxBackups.passphrase")}
                  value={passphrase}
                  minLength={12}
                  maxLength={1024}
                  required
                  autoComplete="new-password"
                  onChange={(e) => setPassphrase(e.currentTarget.value)}
                  hint={t("linuxBackups.encryptionHint")}
                />
                <PasswordField
                  label={t("linuxBackups.repeatPassphrase")}
                  value={repeat}
                  required
                  autoComplete="new-password"
                  onChange={(e) => setRepeat(e.currentTarget.value)}
                  {...(repeat && repeat !== passphrase
                    ? { error: t("linuxBackups.mismatch") }
                    : {})}
                />
              </>
            )}
            <Select
              label={t("linuxBackups.compression")}
              value={compression}
              onChange={setCompression}
              options={[
                { value: "lz4", label: t("linuxBackups.compressionFast") },
                { value: "zstd,3", label: t("linuxBackups.compressionBalanced") },
                { value: "none", label: t("linuxBackups.compressionNone") },
              ]}
            />
          </>
        ) : null}
        {step === 2 ? (
          <>
            {plan?.scheduleOverride ? (
              <Alert tone="warning">
                {t("linuxBackups.customSchedule", { cron: plan.scheduleOverride })}
              </Alert>
            ) : null}
            <Select
              label={t("linuxBackups.schedule")}
              value={schedule.frequency}
              onChange={(frequency) => setSchedule({ ...schedule, frequency })}
              options={(["manual", "hourly", "daily", "weekly", "monthly"] as const).map(
                (value) => ({ value, label: t(`linuxBackups.${value}`) }),
              )}
            />
            {schedule.frequency !== "manual" ? (
              <div className="grid grid-cols-2 gap-3">
                {schedule.frequency === "hourly" ? (
                  <Field
                    type="number"
                    label={t("linuxBackups.minute")}
                    min={0}
                    max={59}
                    value={schedule.minute}
                    onChange={(e) =>
                      setSchedule({ ...schedule, minute: Number(e.currentTarget.value) })
                    }
                  />
                ) : (
                  <Field
                    type="time"
                    label={t("linuxBackups.hour")}
                    value={`${pad(schedule.hour)}:${pad(schedule.minute)}`}
                    onChange={(e) => {
                      const [hour, minute] = e.currentTarget.value.split(":").map(Number);
                      if (hour !== undefined && minute !== undefined)
                        setSchedule({ ...schedule, hour, minute });
                    }}
                  />
                )}
                {schedule.frequency === "weekly" ? (
                  <Select
                    label={t("linuxBackups.weekday")}
                    value={String(schedule.weekday)}
                    onChange={(day) => setSchedule({ ...schedule, weekday: Number(day) })}
                    options={Array.from({ length: 7 }, (_, i) => ({
                      value: String(i),
                      label: new Intl.DateTimeFormat(i18n.language, {
                        weekday: "long",
                        timeZone: "UTC",
                      }).format(new Date(Date.UTC(2026, 10, 1 + i))),
                    }))}
                  />
                ) : null}
                {schedule.frequency === "monthly" ? (
                  <Field
                    type="number"
                    label={t("linuxBackups.day")}
                    min={1}
                    max={28}
                    value={schedule.day}
                    onChange={(e) =>
                      setSchedule({ ...schedule, day: Number(e.currentTarget.value) })
                    }
                  />
                ) : null}
              </div>
            ) : null}
            <p className="text-xs text-fg-subtle">{t("linuxBackups.timezone", { timezone })}</p>
            {schedule.frequency !== "manual" ? (
              <p className="text-xs leading-relaxed text-fg-subtle">
                {t("linuxBackups.sudoSchedule")}
              </p>
            ) : null}
            <div className="rounded-everyos-md border border-line p-4">
              {check(t("linuxBackups.retentionEnable"), retention.enabled, (enabled) =>
                setRetention({ ...retention, enabled }),
              )}
              {retention.enabled ? (
                <div className="mt-4 grid grid-cols-2 gap-3">
                  {(["hourly", "daily", "weekly", "monthly"] as const).map((key) => (
                    <Field
                      key={key}
                      type="number"
                      label={t(`linuxBackups.${keepKey[key]}`)}
                      min={0}
                      max={
                        key === "hourly"
                          ? 744
                          : key === "daily"
                            ? 366
                            : key === "weekly"
                              ? 104
                              : 120
                      }
                      value={retention[key]}
                      onChange={(e) =>
                        setRetention({ ...retention, [key]: Number(e.currentTarget.value) })
                      }
                    />
                  ))}
                </div>
              ) : null}
              <p className="mt-3 text-xs leading-relaxed text-fg-subtle">
                {t("linuxBackups.retentionHint")}
              </p>
            </div>
          </>
        ) : null}
        {step === 3 ? (
          <>
            <div className="flex items-center gap-3 rounded-everyos-md border border-line p-4">
              <ShieldCheck className="size-7 text-accent" aria-hidden />
              <div>
                <p className="font-semibold">{name}</p>
                <p className="text-xs text-fg-muted">
                  {t(`linuxBackups.${scope}Title`)} ·{" "}
                  {t(encryption === "none" ? "linuxBackups.plain" : "linuxBackups.encrypted")}
                </p>
              </div>
            </div>
            <p className="text-sm text-fg-muted">{t("linuxBackups.reviewHint")}</p>
            <p className="flex items-center gap-2 break-all text-xs">
              <HardDrive className="size-4 shrink-0" aria-hidden />
              {capability.targets.find((p) => p.id === targetId)?.path}
            </p>
            {previewError ? (
              <div className="flex flex-col gap-2">
                <Alert tone="danger">{errorMessage(t, previewError)}</Alert>
                <SudoUnlock error={previewError} />
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setPreviewError(null);
                    setPreview(null);
                    setPreviewRevision((v) => v + 1);
                  }}
                >
                  {t("common.refresh")}
                </Button>
              </div>
            ) : preview ? (
              <div className="grid gap-3 sm:grid-cols-2">
                {(
                  [
                    ["includes", preview.paths],
                    ["mandatory", preview.excludes],
                  ] as const
                ).map(([key, values]) => (
                  <div key={key} className="rounded-everyos-md border border-line p-3">
                    <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold">
                      <FolderTree className="size-4" aria-hidden />
                      {t(`linuxBackups.${key}`)}
                    </h3>
                    <ul className="max-h-32 overflow-auto font-mono text-xs text-fg-muted">
                      {values.map((p) => (
                        <li className="break-all" key={p}>
                          {p}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            ) : (
              <p role="status" className="text-sm text-fg-muted">
                {t("common.loading")}
              </p>
            )}
            <Alert tone="warning">{t("linuxBackups.liveWarning")}</Alert>
            {encryption === "none"
              ? check(t("linuxBackups.plainWarning"), consent, setConsent)
              : null}
            <PasswordField
              label={t("linuxBackups.password")}
              value={password}
              required
              autoComplete="current-password"
              onChange={(e) => setPassword(e.currentTarget.value)}
            />
          </>
        ) : null}
        {error ? (
          <>
            <Alert tone="danger">{errorMessage(t, error)}</Alert>
            <SudoUnlock error={error} />
          </>
        ) : null}
        <div className="flex justify-between gap-3 border-t border-line pt-4">
          <Button
            type="button"
            variant="ghost"
            disabled={saving}
            onClick={() => (step ? setStep(step - 1) : onClose())}
          >
            {t(step ? "common.back" : "common.cancel")}
          </Button>
          <Button type="submit" loading={saving} disabled={!valid}>
            {t(step === 3 ? "common.save" : "common.continue")}
            <ChevronRight className="size-4" aria-hidden />
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
