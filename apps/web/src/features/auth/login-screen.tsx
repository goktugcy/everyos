import type { LoginResponse } from "@everyos/shared";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { AuthLayout } from "../../components/auth-layout.tsx";
import { Alert } from "../../components/ui/alert.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Field, PasswordField } from "../../components/ui/field.tsx";
import { api, ApiRequestError } from "../../lib/api.ts";
import { errorMessage } from "../../lib/errors.ts";
import { useSessionStore } from "../../stores/session-store.ts";

type Challenge = { id: string; mode: "totp" | "recovery" };

export function LoginScreen() {
  const { t } = useTranslation();
  const setSession = useSessionStore((state) => state.setSession);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (challenge) codeRef.current?.focus();
  }, [challenge]);

  const handle = (response: LoginResponse) => {
    if (response.status === "authenticated") setSession(response.session);
    else setChallenge({ id: response.challengeId, mode: "totp" });
  };

  const submitPassword = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      handle(
        await api<LoginResponse>("/auth/login", {
          method: "POST",
          body: { username: username.trim(), password },
        }),
      );
      setPassword("");
    } catch (caught) {
      setError(caught);
    } finally {
      setSubmitting(false);
    }
  };

  const submitCode = async (event: FormEvent) => {
    event.preventDefault();
    if (!challenge) return;
    setSubmitting(true);
    setError(null);
    try {
      const body =
        challenge.mode === "totp"
          ? { challengeId: challenge.id, code: code.replace(/\s+/g, "") }
          : { challengeId: challenge.id, recoveryCode: code.trim() };
      handle(await api<LoginResponse>("/auth/login/totp", { method: "POST", body }));
    } catch (caught) {
      setError(caught);
      if (caught instanceof ApiRequestError && caught.code === "AUTH_CHALLENGE_EXPIRED") {
        setChallenge(null);
        setCode("");
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (challenge) {
    const totp = challenge.mode === "totp";
    return (
      <AuthLayout
        title={t("login.totpTitle")}
        subtitle={totp ? t("login.totpHelp") : t("login.recoveryHelp")}
      >
        <form className="flex flex-col gap-4" onSubmit={(event) => void submitCode(event)}>
          <Field
            ref={codeRef}
            label={totp ? t("login.totpCode") : t("login.recoveryCode")}
            value={code}
            onChange={(event) => setCode(event.target.value)}
            autoComplete="one-time-code"
            inputMode={totp ? "numeric" : "text"}
            maxLength={totp ? 7 : 32}
            className="text-center font-mono text-lg tracking-[0.35em]"
            spellCheck={false}
            autoCapitalize="off"
            required
          />
          {error ? <Alert tone="danger">{errorMessage(t, error)}</Alert> : null}
          <Button type="submit" size="lg" loading={submitting} disabled={!code.trim()}>
            {t("login.verify")}
          </Button>
          <div className="flex flex-wrap justify-between gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setChallenge({ ...challenge, mode: totp ? "recovery" : "totp" });
                setCode("");
                setError(null);
              }}
            >
              {totp ? t("login.useRecovery") : t("login.useTotp")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setChallenge(null);
                setCode("");
                setError(null);
              }}
            >
              {t("login.startOver")}
            </Button>
          </div>
        </form>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title={t("login.title")} subtitle={t("login.subtitle")}>
      <form className="flex flex-col gap-4" onSubmit={(event) => void submitPassword(event)}>
        <Field
          label={t("login.username")}
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          autoComplete="username"
          autoCapitalize="off"
          spellCheck={false}
          autoFocus
          required
        />
        <PasswordField
          label={t("login.password")}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="current-password"
          required
        />
        {error ? <Alert tone="danger">{errorMessage(t, error)}</Alert> : null}
        <Button
          type="submit"
          size="lg"
          loading={submitting}
          disabled={!username.trim() || !password}
        >
          {submitting ? t("login.submitting") : t("login.submit")}
        </Button>
      </form>
    </AuthLayout>
  );
}
