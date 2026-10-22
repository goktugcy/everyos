import type { NetTlsResult } from "@everyos/app-sdk";
import { Badge, useI18n, useT } from "@everyos/app-ui";
import { validity } from "./tls.ts";

export function Certificates({ result, now }: { result: NetTlsResult; now: number }) {
  const t = useT();
  const i18n = useI18n();
  const absent = t("result.unavailable");
  return (
    <div className="ssl-results">
      <div className="ssl-status">
        {result.authorized ? (
          <Badge>{t("result.trusted")}</Badge>
        ) : (
          <p role="alert" className="ssl-warning">
            {t("result.untrusted")}
            {result.authorizationError ? <code>{result.authorizationError}</code> : null}
          </p>
        )}
        {result.hostnameMatches ? (
          <Badge>{t("result.matches")}</Badge>
        ) : (
          <p role="alert" className="ssl-warning">
            {t("result.mismatch")}
          </p>
        )}
      </div>
      <dl className="ssl-details">
        <dt>{t("result.remote")}</dt>
        <dd>
          <code>{result.remoteAddress}</code>
        </dd>
        <dt>{t("result.protocol")}</dt>
        <dd>{result.protocol ?? absent}</dd>
        <dt>{t("result.cipher")}</dt>
        <dd>
          <code>{result.cipher?.standardName || result.cipher?.name || absent}</code>
        </dd>
        <dt>{t("result.alpn")}</dt>
        <dd>{result.alpn ?? absent}</dd>
        <dt>{t("result.time")}</dt>
        <dd>
          {i18n.number(result.ms, { style: "unit", unit: "millisecond", maximumFractionDigits: 1 })}
        </dd>
      </dl>
      <h2>{t("result.chain")}</h2>
      {!result.chain.length ? (
        <p>{t("result.noChain")}</p>
      ) : (
        result.chain.map((cert, index) => {
          const state = validity(cert, now);
          return (
            <section
              className="ssl-certificate"
              key={`${index}/${cert.fingerprint256}`}
              aria-label={`${t("result.chain")} ${i18n.number(index + 1)}`}
            >
              <h3>{cert.subject || absent}</h3>
              <p
                className={state === "valid" ? "ssl-valid" : "ssl-warning"}
                role={state === "valid" ? undefined : "alert"}
              >
                {t(`validity.${state}`)}
              </p>
              {cert.selfSigned ? <Badge>{t("cert.selfSigned")}</Badge> : null}
              <dl className="ssl-details">
                <dt>{t("cert.subject")}</dt>
                <dd>{cert.subject || absent}</dd>
                <dt>{t("cert.issuer")}</dt>
                <dd>{cert.issuer || absent}</dd>
                <dt>{t("cert.from")}</dt>
                <dd>
                  <time dateTime={new Date(cert.validFrom).toISOString()}>
                    {i18n.date(cert.validFrom, { dateStyle: "long", timeStyle: "short" })}
                  </time>
                </dd>
                <dt>{t("cert.to")}</dt>
                <dd>
                  <time dateTime={new Date(cert.validTo).toISOString()}>
                    {i18n.date(cert.validTo, { dateStyle: "long", timeStyle: "short" })}
                  </time>
                </dd>
                <dt>{t("cert.sans")}</dt>
                <dd>
                  {cert.subjectAltNames.length ? (
                    <ul>
                      {cert.subjectAltNames.map((name, i) => (
                        <li key={i}>
                          <code>{name}</code>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    absent
                  )}
                </dd>
                <dt>{t("cert.key")}</dt>
                <dd>
                  {cert.keyType ?? absent}
                  {cert.keyBits === null ? "" : ` · ${i18n.number(cert.keyBits)}`}
                </dd>
                <dt>{t("cert.serial")}</dt>
                <dd>
                  <code>{cert.serialNumber}</code>
                </dd>
                <dt>{t("cert.fingerprint")}</dt>
                <dd>
                  <code>{cert.fingerprint256}</code>
                </dd>
              </dl>
            </section>
          );
        })
      )}
    </div>
  );
}
