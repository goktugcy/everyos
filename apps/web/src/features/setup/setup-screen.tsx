import {
  PASSWORD_MIN_LENGTH,
  SUPPORTED_LOCALES,
  type Locale,
  type SessionInfo,
} from "@otuken/shared";
import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { applyLocale } from "../../app/i18n.ts";
import { AuthLayout } from "../../components/auth-layout.tsx";
import { Alert } from "../../components/ui/alert.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Field, PasswordField } from "../../components/ui/field.tsx";
import { api, ApiRequestError } from "../../lib/api.ts";
import { cn } from "../../lib/cn.ts";
import { errorMessage, passwordViolations } from "../../lib/errors.ts";
import { useSessionStore } from "../../stores/session-store.ts";

type Step = "language" | "verify" | "account";
const STEPS: Step[] = ["language", "verify", "account"];
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,31}$/;

function Stepper({ current }: { current: Step }) {
  const { t } = useTranslation();
  const index = STEPS.indexOf(current);
  return (
    <ol className="mb-6 grid grid-cols-3 gap-2" aria-label={t("setup.title")}>
      {STEPS.map((step, i) => (
        <li
          key={step}
          className="flex flex-col gap-2"
          aria-current={i === index ? "step" : undefined}
        >
          <span
            className={cn(
              "h-1 rounded-full transition-colors",
              i <= index ? "bg-accent" : "bg-white/12",
            )}
          />
          <span className={cn("text-xs font-medium", i === index ? "text-fg" : "text-fg-subtle")}>
            {t(`setup.steps.${step}`)}
          </span>
        </li>
      ))}
    </ol>
  );
}

function CopyableCommand({ command }: { command: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="glass-inset flex items-center justify-between gap-2 rounded-otk-md py-1.5 pl-3.5 pr-1.5">
      <code className="truncate font-mono text-[0.8rem] text-accent">{command}</code>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => void copy()}
        aria-label={copied ? t("common.copied") : t("common.copy")}
      >
        {copied ? (
          <Check className="size-4 text-success" aria-hidden />
        ) : (
          <Copy className="size-4" aria-hidden />
        )}
      </Button>
    </div>
  );
}

export function SetupScreen() {
  const { t, i18n } = useTranslation();
  const bootstrap = useSessionStore((state) => state.bootstrap);
  const setSession = useSessionStore((state) => state.setSession);
  const [step, setStep] = useState<Step>("language");
  const [setupToken, setSetupToken] = useState("");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [touched, setTouched] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const firstRender = useRef(true);

  // Move focus to the new step's heading for screen readers, but not on first load.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    headingRef.current?.focus();
  }, [step]);

  const usernameValid = USERNAME_PATTERN.test(username);
  const passwordLongEnough = [...password.normalize("NFKC")].length >= PASSWORD_MIN_LENGTH;
  const passwordsMatch = password === passwordConfirm;
  const violations = passwordViolations(error);
  const tokenError = error instanceof ApiRequestError && error.code === "SETUP_TOKEN_INVALID";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (!usernameValid || !passwordLongEnough || !passwordsMatch || !displayName.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const session = await api<SessionInfo>("/setup", {
        method: "POST",
        body: {
          setupToken: setupToken.trim(),
          username,
          displayName: displayName.trim(),
          password,
          locale: i18n.language as Locale,
        },
      });
      setSession(session);
    } catch (caught) {
      setError(caught);
      if (caught instanceof ApiRequestError && caught.code === "SETUP_TOKEN_INVALID")
        setStep("verify");
      if (caught instanceof ApiRequestError && caught.code === "SETUP_ALREADY_COMPLETED") {
        void useSessionStore.getState().boot();
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthLayout title={t("setup.title")} subtitle={t("setup.subtitle")}>
      <Stepper current={step} />

      {step === "language" ? (
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-1">
            <h2 ref={headingRef} tabIndex={-1} className="text-base font-semibold outline-none">
              {t("setup.languageTitle")}
            </h2>
            <p className="text-sm text-fg-muted">{t("setup.languageHelp")}</p>
          </div>
          <div
            role="radiogroup"
            aria-label={t("common.language")}
            className="grid grid-cols-2 gap-3"
          >
            {SUPPORTED_LOCALES.map((locale) => {
              const selected = i18n.language === locale;
              return (
                <button
                  key={locale}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  lang={locale}
                  onClick={() => applyLocale(locale)}
                  className={cn(
                    "glass-inset flex h-16 items-center justify-between rounded-otk-md px-4 text-left text-sm font-medium transition-colors",
                    selected
                      ? "border-accent/70 bg-accent/12 text-fg"
                      : "text-fg-muted hover:text-fg",
                  )}
                >
                  {t(`languages.${locale}`)}
                  {selected ? <Check className="size-4 text-accent" aria-hidden /> : null}
                </button>
              );
            })}
          </div>
          <Button size="lg" onClick={() => setStep("verify")}>
            {t("common.continue")}
          </Button>
        </div>
      ) : null}

      {step === "verify" ? (
        <form
          className="flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (setupToken.trim()) {
              setError(null);
              setStep("account");
            }
          }}
        >
          <div className="flex flex-col gap-2">
            <h2 ref={headingRef} tabIndex={-1} className="text-base font-semibold outline-none">
              {t("setup.tokenTitle")}
            </h2>
            <p className="text-sm leading-relaxed text-fg-muted">{t("setup.tokenHelp")}</p>
            <CopyableCommand command={t("setup.tokenCommand")} />
            {bootstrap?.mode === "development" ? (
              <p className="text-xs text-fg-subtle">{t("setup.tokenDevHint")}</p>
            ) : null}
          </div>
          <Field
            label={t("setup.tokenLabel")}
            value={setupToken}
            onChange={(event) => setSetupToken(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="off"
            className="font-mono"
            required
            error={tokenError ? t("errors.SETUP_TOKEN_INVALID") : undefined}
          />
          <div className="flex gap-3">
            <Button
              variant="secondary"
              size="lg"
              className="flex-1"
              onClick={() => setStep("language")}
            >
              {t("common.back")}
            </Button>
            <Button type="submit" size="lg" className="flex-1" disabled={!setupToken.trim()}>
              {t("common.continue")}
            </Button>
          </div>
        </form>
      ) : null}

      {step === "account" ? (
        <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)} noValidate>
          <h2 ref={headingRef} tabIndex={-1} className="text-base font-semibold outline-none">
            {t("setup.accountTitle")}
          </h2>
          <Field
            label={t("setup.username")}
            value={username}
            onChange={(event) => setUsername(event.target.value.toLowerCase())}
            autoComplete="username"
            autoCapitalize="off"
            spellCheck={false}
            hint={t("setup.usernameHint")}
            error={touched && !usernameValid ? t("validation.usernameFormat") : undefined}
            required
          />
          <Field
            label={t("setup.displayName")}
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            autoComplete="name"
            error={touched && !displayName.trim() ? t("validation.required") : undefined}
            required
          />
          <PasswordField
            label={t("setup.password")}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="new-password"
            hint={t("setup.passwordHint", { min: PASSWORD_MIN_LENGTH })}
            error={
              touched && !passwordLongEnough
                ? t("validation.passwordPolicy.too-short", { min: PASSWORD_MIN_LENGTH })
                : violations.length > 0
                  ? violations
                      .map((v) =>
                        t(`validation.passwordPolicy.${v as "too-short"}`, {
                          min: PASSWORD_MIN_LENGTH,
                        }),
                      )
                      .join(" ")
                  : undefined
            }
            required
          />
          <PasswordField
            label={t("setup.passwordConfirm")}
            value={passwordConfirm}
            onChange={(event) => setPasswordConfirm(event.target.value)}
            autoComplete="new-password"
            error={touched && !passwordsMatch ? t("setup.passwordMismatch") : undefined}
            required
          />
          {error && !tokenError && violations.length === 0 ? (
            <Alert tone="danger">{errorMessage(t, error)}</Alert>
          ) : null}
          <div className="flex gap-3 pt-1">
            <Button
              variant="secondary"
              size="lg"
              className="flex-1"
              onClick={() => setStep("verify")}
              disabled={submitting}
            >
              {t("common.back")}
            </Button>
            <Button type="submit" size="lg" className="flex-[2]" loading={submitting}>
              {submitting ? t("setup.submitting") : t("setup.submit")}
            </Button>
          </div>
        </form>
      ) : null}
    </AuthLayout>
  );
}
