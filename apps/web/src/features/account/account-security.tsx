import {
  PASSWORD_MIN_LENGTH,
  type PublicUser,
  type RecoveryCodesResponse,
  type SessionSummary,
  type TotpEnrollmentResponse,
} from "@everyos/shared";
import { Check, Copy, Laptop } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { renderSVG } from "uqr";
import { Alert } from "../../components/ui/alert.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Field, PasswordField } from "../../components/ui/field.tsx";
import { api } from "../../lib/api.ts";
import { cn } from "../../lib/cn.ts";
import { errorMessage, passwordViolations } from "../../lib/errors.ts";
import { formatDateTime } from "../../lib/format.ts";

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-3">
      <Alert tone="warning" title={t("account.recovery.title")}>
        {t("account.recovery.help")}
      </Alert>
      <ul className="glass-inset grid grid-cols-2 gap-x-6 gap-y-1.5 rounded-everyos-md p-4 font-mono text-sm">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <div className="flex gap-3">
        <Button
          variant="secondary"
          onClick={() => {
            void navigator.clipboard.writeText(codes.join("\n")).then(() => setCopied(true));
          }}
        >
          {copied ? (
            <Check className="size-4" aria-hidden />
          ) : (
            <Copy className="size-4" aria-hidden />
          )}
          {copied ? t("common.copied") : t("common.copy")}
        </Button>
        <Button className="flex-1" onClick={onDone}>
          {t("account.recovery.saved")}
        </Button>
      </div>
    </div>
  );
}

export function TwoFactorSection({
  user,
  onUserChange,
}: {
  user: PublicUser;
  onUserChange: (user: PublicUser) => void;
}) {
  const { t } = useTranslation();
  const [enrollment, setEnrollment] = useState<TotpEnrollmentResponse | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [disabling, setDisabling] = useState(false);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const qr = useMemo(
    () =>
      enrollment
        ? `data:image/svg+xml;utf8,${encodeURIComponent(renderSVG(enrollment.otpauthUri, { border: 2 }))}`
        : null,
    [enrollment],
  );

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  if (recoveryCodes) {
    return (
      <RecoveryCodes
        codes={recoveryCodes}
        onDone={() => {
          setRecoveryCodes(null);
          onUserChange({ ...user, totpEnabled: true });
        }}
      />
    );
  }

  if (enrollment && qr) {
    const confirm = (event: FormEvent) => {
      event.preventDefault();
      void run(async () => {
        const result = await api<RecoveryCodesResponse>("/account/totp/enable", {
          method: "POST",
          body: { code: code.trim() },
        });
        setEnrollment(null);
        setCode("");
        setRecoveryCodes(result.recoveryCodes);
      });
    };
    return (
      <form className="flex flex-col gap-4" onSubmit={confirm}>
        <p className="text-sm text-fg-muted">{t("account.totp.scan")}</p>
        <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
          <img src={qr} alt="" className="size-40 shrink-0 rounded-everyos-md bg-white p-1" />
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <div className="flex flex-col gap-1">
              <span className="text-xs text-fg-subtle">{t("account.totp.secret")}</span>
              <code className="glass-inset break-all rounded-everyos-sm px-3 py-2 font-mono text-xs">
                {enrollment.secret}
              </code>
            </div>
            <Field
              label={t("account.totp.confirmCode")}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              className="font-mono tracking-[0.3em]"
              required
            />
          </div>
        </div>
        {error ? <Alert tone="danger">{errorMessage(t, error)}</Alert> : null}
        <div className="flex justify-end gap-3">
          <Button variant="ghost" onClick={() => setEnrollment(null)}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" loading={busy} disabled={!/^\d{6}$/.test(code.trim())}>
            {t("account.totp.confirm")}
          </Button>
        </div>
      </form>
    );
  }

  if (disabling) {
    const disable = (event: FormEvent) => {
      event.preventDefault();
      void run(async () => {
        await api("/account/totp/disable", {
          method: "POST",
          body: { password, code: code.trim() },
        });
        setDisabling(false);
        setPassword("");
        setCode("");
        setNotice(t("account.totp.disabledNotice"));
        onUserChange({ ...user, totpEnabled: false });
      });
    };
    return (
      <form className="flex flex-col gap-3" onSubmit={disable}>
        <p className="text-sm text-fg-muted">{t("account.totp.disableHelp")}</p>
        <PasswordField
          label={t("account.password.current")}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
        />
        <Field
          label={t("login.totpCode")}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          required
        />
        {error ? <Alert tone="danger">{errorMessage(t, error)}</Alert> : null}
        <div className="flex justify-end gap-3">
          <Button variant="ghost" onClick={() => setDisabling(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            type="submit"
            variant="danger"
            loading={busy}
            disabled={!password || !/^\d{6}$/.test(code.trim())}
          >
            {t("account.totp.disable")}
          </Button>
        </div>
      </form>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-fg-muted">{t("account.totp.description")}</p>
        <span
          className={cn(
            "shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold",
            user.totpEnabled ? "bg-success/15 text-success" : "bg-hover/8 text-fg-subtle",
          )}
        >
          {user.totpEnabled ? t("account.totp.enabled") : t("account.totp.disabled")}
        </span>
      </div>
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {error ? <Alert tone="danger">{errorMessage(t, error)}</Alert> : null}
      <div className="flex justify-end">
        {user.totpEnabled ? (
          <Button variant="secondary" onClick={() => setDisabling(true)}>
            {t("account.totp.disable")}
          </Button>
        ) : (
          <Button
            loading={busy}
            onClick={() =>
              void run(async () =>
                setEnrollment(
                  await api<TotpEnrollmentResponse>("/account/totp/enroll", { method: "POST" }),
                ),
              )
            }
          >
            {t("account.totp.enable")}
          </Button>
        )}
      </div>
    </div>
  );
}

export function PasswordSection() {
  const { t } = useTranslation();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);
  const violations = passwordViolations(error);
  const mismatch = confirm.length > 0 && next !== confirm;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (mismatch) return;
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      await api("/account/password", {
        method: "POST",
        body: { currentPassword: current, newPassword: next },
      });
      setCurrent("");
      setNext("");
      setConfirm("");
      setDone(true);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="flex flex-col gap-3" onSubmit={(event) => void submit(event)}>
      <PasswordField
        label={t("account.password.current")}
        value={current}
        onChange={(e) => setCurrent(e.target.value)}
        autoComplete="current-password"
        required
      />
      <PasswordField
        label={t("account.password.next")}
        value={next}
        onChange={(e) => setNext(e.target.value)}
        autoComplete="new-password"
        hint={t("setup.passwordHint", { min: PASSWORD_MIN_LENGTH })}
        error={
          violations.length > 0
            ? violations
                .map((v) =>
                  t(`validation.passwordPolicy.${v as "too-short"}`, { min: PASSWORD_MIN_LENGTH }),
                )
                .join(" ")
            : undefined
        }
        required
      />
      <PasswordField
        label={t("account.password.confirm")}
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        autoComplete="new-password"
        error={mismatch ? t("setup.passwordMismatch") : undefined}
        required
      />
      {done ? <Alert tone="success">{t("account.password.changed")}</Alert> : null}
      {error && violations.length === 0 ? (
        <Alert tone="danger">{errorMessage(t, error)}</Alert>
      ) : null}
      <div className="flex justify-end">
        <Button
          type="submit"
          loading={busy}
          disabled={!current || next.length < PASSWORD_MIN_LENGTH || mismatch}
        >
          {t("account.password.submit")}
        </Button>
      </div>
    </form>
  );
}

export function SessionsSection() {
  const { t, i18n } = useTranslation();
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    api<{ sessions: SessionSummary[] }>("/auth/sessions", { signal: controller.signal }).then(
      (result) => setSessions(result.sessions),
      (caught: unknown) => {
        if (!controller.signal.aborted) setError(caught);
      },
    );
    return () => controller.abort();
  }, [revision]);

  const revoke = async (id: string) => {
    try {
      await api(`/auth/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
      setRevision((value) => value + 1);
    } catch (caught) {
      setError(caught);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {error ? <Alert tone="danger">{errorMessage(t, error)}</Alert> : null}
      {sessions?.map((session) => (
        <div
          key={session.id}
          className="glass-inset flex items-center gap-3 rounded-everyos-md px-3.5 py-3"
        >
          <Laptop className="size-4 shrink-0 text-fg-subtle" aria-hidden />
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm" title={session.userAgent ?? undefined}>
              {session.userAgent ?? t("account.sessions.unknownDevice")}
            </span>
            <span className="text-xs text-fg-subtle">
              {session.ip ?? "—"} ·{" "}
              {t("account.sessions.lastSeen", {
                time: formatDateTime(session.lastSeenAt, i18n.language),
              })}
            </span>
          </div>
          {session.current ? (
            <span className="shrink-0 rounded-full bg-accent/15 px-2.5 py-1 text-xs font-semibold text-accent">
              {t("account.sessions.current")}
            </span>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => void revoke(session.id)}>
              {t("account.sessions.revoke")}
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}
