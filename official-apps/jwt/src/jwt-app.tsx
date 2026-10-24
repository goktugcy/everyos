import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  IconButton,
  Select,
  Spacer,
  Switch,
  Tabs,
  TextArea,
  Toolbar,
  ToolbarTitle,
  errorMessage,
  saveTextFile,
  useApp,
  useI18n,
  useNarrow,
  usePersistentState,
  useT,
  useToast,
} from "@everyos/app-ui";
import { Copy, FileDown, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  decode,
  PERSONAL_CLAIMS,
  redact,
  REGISTERED_CLAIMS,
  TIME_CLAIMS,
  validity,
  verify,
  type SecretEncoding,
  type VerifyResult,
} from "./jwt.ts";

type Panel = "decoded" | "verify" | "export";

/** "in 3 hours", "2 days ago" in the person's language. */
function relative(seconds: number, locale: string): string {
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const abs = Math.abs(seconds);
  const [value, unit]: [number, Intl.RelativeTimeFormatUnit] =
    abs < 60
      ? [seconds, "second"]
      : abs < 3600
        ? [seconds / 60, "minute"]
        : abs < 86_400
          ? [seconds / 3600, "hour"]
          : abs < 86_400 * 60
            ? [seconds / 86_400, "day"]
            : abs < 86_400 * 730
              ? [seconds / (86_400 * 30), "month"]
              : [seconds / (86_400 * 365), "year"];
  return format.format(Math.round(value), unit);
}

export function JwtApp() {
  const app = useApp();
  const t = useT();
  const i18n = useI18n();
  const toast = useToast();
  const narrow = useNarrow(860);
  // Tokens stay in memory unless the person asks to remember the last one on this device.
  const [remember, setRemember] = usePersistentState("remember", false);
  const [token, setToken] = useState("");
  const [panel, setPanel] = useState<Panel>("decoded");
  const [skew, setSkew] = useState(0);
  const [key, setKey] = useState("");
  const [encoding, setEncoding] = useState<SecretEncoding>("text");
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [hidden, setHidden] = useState<Set<string> | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    void app.storage.get<string>("token").then((stored) => {
      if (typeof stored === "string") setToken(stored);
    });
  }, [app]);
  useEffect(() => {
    const timer = setTimeout(() => {
      if (remember) void app.storage.set("token", token).catch(() => undefined);
      else void app.storage.delete("token").catch(() => undefined);
    }, 300);
    return () => clearTimeout(timer);
  }, [app, remember, token]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);

  const decoded = useMemo(() => decode(token), [token]);
  const payload = decoded.ok ? decoded.token.payload : null;
  const state = decoded.ok ? validity(payload, now, skew) : null;
  const alg = decoded.ok
    ? typeof decoded.token.header.alg === "string"
      ? decoded.token.header.alg
      : ""
    : "";
  useEffect(() => setResult(null), [token, key, encoding]);

  // Personal claims are redacted by default when exporting.
  const redacted = useMemo(
    () =>
      hidden ??
      new Set(
        Object.keys(payload ?? {}).filter((claim) =>
          (PERSONAL_CLAIMS as readonly string[]).includes(claim),
        ),
      ),
    [hidden, payload],
  );
  const exported = decoded.ok
    ? JSON.stringify(
        { header: decoded.token.header, payload: payload ? redact(payload, redacted) : null },
        null,
        2,
      )
    : "";

  const copy = async (text: string) => {
    try {
      await app.clipboard.writeText(text);
      toast(t("ui.copied"));
    } catch (caught) {
      toast(errorMessage(t, caught), "danger");
    }
  };

  const formatTime = (seconds: number) =>
    `${i18n.date(seconds * 1000, { dateStyle: "medium", timeStyle: "long" })} (${relative(seconds - now / 1000, i18n.tag)})`;
  const claimValue = (claim: string, value: unknown) =>
    (TIME_CLAIMS as readonly string[]).includes(claim) && typeof value === "number"
      ? formatTime(value)
      : typeof value === "string"
        ? value
        : JSON.stringify(value);

  return (
    <div className="jwt-app">
      <Toolbar label={t("app.name")}>
        <ToolbarTitle>{t("app.name")}</ToolbarTitle>
        <Spacer />
        <label className="jwt-switch" title={t("remember.hint")}>
          <Switch label={t("remember.label")} checked={remember} onChange={setRemember} />
          <span aria-hidden>{t("remember.label")}</span>
        </label>
      </Toolbar>
      <div className="jwt-body" data-narrow={narrow || undefined}>
        <section className="jwt-input" aria-label={t("token.section")}>
          <TextArea
            label={t("token.label")}
            className="eui-textarea eui-mono jwt-token"
            value={token}
            placeholder={t("token.placeholder")}
            spellCheck={false}
            onChange={(event) => setToken(event.target.value)}
          />
          {decoded.ok ? (
            <p className="jwt-colored eui-mono" aria-label={t("token.parts")}>
              <span data-part="header">{decoded.token.parts[0]}</span>.
              <span data-part="payload">{decoded.token.parts[1]}</span>.
              <span data-part="signature">{decoded.token.parts[2]}</span>
            </p>
          ) : null}
          <div className="jwt-status" role="status">
            {!decoded.ok ? (
              decoded.problem === "empty" ? (
                <span className="eui-hint">{t("token.privacy")}</span>
              ) : (
                <Badge tone="danger">
                  {t(`problems.${decoded.problem}`, { part: t(`parts.${decoded.part ?? 0}`) })}
                </Badge>
              )
            ) : (
              <>
                <Badge tone="accent">{alg || t("token.noAlg")}</Badge>
                {state?.state === "valid" ? (
                  <Badge tone="success">
                    {state.expiresIn === null
                      ? t("validity.valid")
                      : t("validity.expiresIn", { when: relative(state.expiresIn, i18n.tag) })}
                  </Badge>
                ) : state?.state === "expired" ? (
                  <Badge tone="danger">
                    {t("validity.expired", { when: relative(-state.ago, i18n.tag) })}
                  </Badge>
                ) : state?.state === "not-yet" ? (
                  <Badge tone="warning">
                    {t("validity.notYet", { when: relative(state.in, i18n.tag) })}
                  </Badge>
                ) : (
                  <Badge>{t("validity.noExpiry")}</Badge>
                )}
                {alg.toLowerCase() === "none" ? (
                  <Badge tone="danger">{t("token.algNone")}</Badge>
                ) : null}
                <label className="jwt-skew">
                  {t("validity.skew")}
                  <select
                    className="eui-select"
                    value={skew}
                    onChange={(event) => setSkew(Number(event.target.value))}
                  >
                    {[0, 30, 60, 300].map((seconds) => (
                      <option key={seconds} value={seconds}>
                        {t("validity.seconds", { count: seconds })}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}
          </div>
        </section>
        <section className="jwt-panel" aria-label={t(`panels.${panel}`)}>
          <Tabs<Panel>
            label={t("panels.label")}
            value={panel}
            onChange={setPanel}
            tabs={(["decoded", "verify", "export"] as const).map((value) => ({
              value,
              label: t(`panels.${value}`),
            }))}
          />
          <div className="jwt-panel-body">
            {!decoded.ok ? (
              <EmptyState
                icon={<ShieldCheck size={28} aria-hidden />}
                title={t("token.waiting")}
                text={t("token.privacy")}
              />
            ) : panel === "decoded" ? (
              <>
                <h2>{t("decoded.header")}</h2>
                <pre className="jwt-json">{JSON.stringify(decoded.token.header, null, 2)}</pre>
                <h2>{t("decoded.payload")}</h2>
                {payload ? (
                  <>
                    <table className="eui-table jwt-claims">
                      <thead>
                        <tr>
                          <th>{t("decoded.claim")}</th>
                          <th>{t("decoded.value")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {Object.entries(payload).map(([claim, value]) => (
                          <tr key={claim}>
                            <th scope="row">
                              <code>{claim}</code>
                              {(REGISTERED_CLAIMS as readonly string[]).includes(claim) ? (
                                <span className="jwt-claim-name">{t(`claims.${claim}`)}</span>
                              ) : null}
                            </th>
                            <td className="jwt-value">{claimValue(claim, value)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <pre className="jwt-json">{JSON.stringify(payload, null, 2)}</pre>
                  </>
                ) : (
                  <pre className="jwt-json">{decoded.token.payloadText}</pre>
                )}
              </>
            ) : panel === "verify" ? (
              <div className="jwt-verify">
                <p className="eui-hint">
                  {alg.startsWith("HS") ? t("verify.secretHint") : t("verify.keyHint")}
                </p>
                {alg.startsWith("HS") ? (
                  <Select<SecretEncoding>
                    label={t("verify.encoding")}
                    value={encoding}
                    onChange={setEncoding}
                    options={(["text", "base64", "base64url"] as const).map((value) => ({
                      value,
                      label: t(`verify.encodings.${value}`),
                    }))}
                  />
                ) : null}
                <TextArea
                  label={alg.startsWith("HS") ? t("verify.secret") : t("verify.key")}
                  className="eui-textarea eui-mono jwt-key"
                  value={key}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(event) => setKey(event.target.value)}
                />
                <Button
                  variant="primary"
                  icon={<ShieldCheck size={15} aria-hidden />}
                  disabled={!key.trim() || checking}
                  onClick={async () => {
                    setChecking(true);
                    setResult(await verify(token, key, encoding));
                    setChecking(false);
                  }}
                >
                  {t("verify.check")}
                </Button>
                {result ? (
                  <p className="jwt-result" role="alert" data-result={result}>
                    <Badge tone={result === "valid" ? "success" : "danger"}>
                      {t(`verify.results.${result}`, { alg })}
                    </Badge>
                  </p>
                ) : null}
                <p className="eui-hint">{t("verify.private")}</p>
              </div>
            ) : (
              <div className="jwt-export">
                <p className="eui-hint">{t("export.hint")}</p>
                <div className="jwt-redact" role="group" aria-label={t("export.redact")}>
                  {Object.keys(payload ?? {}).map((claim) => (
                    <Checkbox
                      key={claim}
                      label={t("export.redactClaim", { claim })}
                      checked={redacted.has(claim)}
                      onChange={(checked) => {
                        const next = new Set(redacted);
                        if (checked) next.add(claim);
                        else next.delete(claim);
                        setHidden(next);
                      }}
                    />
                  ))}
                </div>
                <pre className="jwt-json" aria-label={t("export.preview")}>
                  {exported}
                </pre>
                <div className="jwt-actions">
                  <Button icon={<Copy size={14} aria-hidden />} onClick={() => void copy(exported)}>
                    {t("export.copy")}
                  </Button>
                  <IconButton
                    label={t("export.save")}
                    icon={<FileDown size={16} aria-hidden />}
                    onClick={async () => {
                      try {
                        if (
                          await saveTextFile(app, "token-claims.json", `${exported}\n`, {
                            accept: [".json"],
                          })
                        )
                          toast(t("ui.exported"));
                      } catch (caught) {
                        toast(errorMessage(t, caught), "danger");
                      }
                    }}
                  />
                </div>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
