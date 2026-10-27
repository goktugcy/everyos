import type { DnsRecordType, NetDnsResult } from "@everyos/app-sdk";
import { Badge, Button, DataTable, networkMessage, useI18n, useT } from "@everyos/app-ui";
import { ordered } from "./sort.ts";
import { recordValue, txtKind } from "./dns.ts";

export interface Answer {
  type: DnsRecordType;
  result?: NetDnsResult;
  error?: unknown;
}

export function Results({ answers, copy }: { answers: Answer[]; copy: (text: string) => void }) {
  const t = useT();
  const i18n = useI18n();
  const max = Math.max(1, ...answers.map((answer) => answer.result?.records.length ?? 0));
  return (
    <div className="dns-results">
      <div className="dns-overview" aria-label={t("results.overview")}>
        {answers.map(({ type, result }) => (
          <div key={type} className="dns-count">
            <strong>{type}</strong>
            <span className="dns-bar" aria-hidden>
              <span style={{ width: `${(100 * (result?.records.length ?? 0)) / max}%` }} />
            </span>
            <span>{i18n.number(result?.records.length ?? 0)}</span>
          </div>
        ))}
      </div>
      {answers.map(({ type, result, error }) => (
        <section key={type} className="dns-answer" aria-label={type}>
          <div className="dns-answer-heading">
            <h2>{type}</h2>
            {result ? (
              <>
                <Badge>{t(`status.${result.status}`)}</Badge>
                <span>
                  {t("results.timing", {
                    ms: i18n.number(result.ms, { maximumFractionDigits: 1 }),
                  })}
                </span>
                {result.records.length ? (
                  <Button
                    size="sm"
                    onClick={() => copy(result.records.map(recordValue).join("\n"))}
                  >
                    {t("ui.copy")}
                  </Button>
                ) : null}
              </>
            ) : null}
          </div>
          {error ? (
            <p role="alert" className="eui-error-text">
              {networkMessage(t, error)}
            </p>
          ) : null}
          {result ? (
            <>
              <p className="dns-meta">
                {t("results.servers", { servers: result.servers.join(", ") })}
              </p>
              {result.records.length ? (
                <div className="dns-table">
                  <DataTable
                    label={t("results.records", { type })}
                    rows={ordered(result.records).map((record, index) => ({
                      record,
                      id: String(index),
                    }))}
                    getKey={(row) => row.id}
                    columns={[
                      {
                        key: "value",
                        label: t("results.value"),
                        render: ({ record }) => (
                          <>
                            <code>{recordValue(record)}</code>
                            {record.type === "TXT" && txtKind(result.name, record.text) ? (
                              <Badge>{t(`txt.${txtKind(result.name, record.text)}`)}</Badge>
                            ) : null}
                          </>
                        ),
                      },
                      {
                        key: "ttl",
                        label: t("results.ttl"),
                        render: ({ record }) =>
                          "ttl" in record
                            ? i18n.number(record.ttl, { style: "unit", unit: "second" })
                            : t("results.unavailable"),
                      },
                    ]}
                  />
                </div>
              ) : (
                <p>{t(`status.${result.status === "ok" ? "no-data" : result.status}`)}</p>
              )}
            </>
          ) : null}
        </section>
      ))}
    </div>
  );
}
