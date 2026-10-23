import { Button, DataTable, SearchInput, formatBytes, useI18n, useT } from "@everyos/app-ui";
import { Folder } from "lucide-react";
import { useState } from "react";
import { PAGE_SIZE, trendPoints, usedPercent, type FolderScan, type Sample } from "./disk.ts";

export function FolderDetails({
  scan,
  busy,
  onNavigate,
}: {
  scan: FolderScan;
  busy: boolean;
  onNavigate: (name: string) => void;
}) {
  const t = useT();
  const i18n = useI18n();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const { value } = scan;
  const rows = value.children.filter((child) =>
    child.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
  );
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  const bytes = (size: number) => formatBytes(size, i18n.tag);
  return (
    <>
      <section className="disk-panel" aria-label={t("disk.breakdown")}>
        <h2>{t("disk.breakdown")}</h2>
        <dl className="disk-stats">
          <div>
            <dt>{t("disk.size")}</dt>
            <dd>{bytes(value.total)}</dd>
          </div>
          <div>
            <dt>{t("disk.files")}</dt>
            <dd>{i18n.number(value.files)}</dd>
          </div>
          <div>
            <dt>{t("disk.folders")}</dt>
            <dd>{i18n.number(value.folders)}</dd>
          </div>
        </dl>
        <SearchInput
          label={t("disk.search")}
          value={search}
          onChange={(value) => {
            setSearch(value);
            setPage(0);
          }}
        />
        <div className="disk-table">
          <DataTable
            rows={rows.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE)}
            getKey={(row) => row.name}
            label={t("disk.children")}
            columns={[
              {
                key: "name",
                label: t("disk.name"),
                render: (row) =>
                  row.kind === "directory" ? (
                    <Button
                      className="disk-folder"
                      disabled={busy}
                      icon={<Folder size={14} aria-hidden />}
                      onClick={() => onNavigate(row.name)}
                    >
                      {row.name}
                    </Button>
                  ) : (
                    <span>{row.name}</span>
                  ),
              },
              {
                key: "size",
                label: t("disk.size"),
                render: (row) => (
                  <div className="disk-size">
                    <span>{bytes(row.size)}</span>
                    <span className="disk-bar" aria-hidden>
                      <i style={{ width: `${usedPercent(row.size, value.total)}%` }} />
                    </span>
                  </div>
                ),
              },
              { key: "items", label: t("disk.items"), render: (row) => i18n.number(row.items) },
            ]}
          />
        </div>
        {!rows.length ? <p>{t("disk.noMatch")}</p> : null}
        <div className="disk-pagination">
          <Button disabled={current === 0} onClick={() => setPage(current - 1)}>
            {t("disk.previous")}
          </Button>
          <span>{t("disk.page", { page: current + 1, pages })}</span>
          <Button disabled={current + 1 >= pages} onClick={() => setPage(current + 1)}>
            {t("disk.next")}
          </Button>
        </div>
      </section>
      <div className="disk-columns">
        <section className="disk-panel">
          <h2>{t("disk.largest")}</h2>
          <p className="disk-hint">{t("disk.largestHint")}</p>
          <div className="disk-table">
            <DataTable
              rows={value.largest}
              getKey={(row) => row.path}
              label={t("disk.largest")}
              columns={[
                { key: "path", label: t("disk.location"), render: (row) => row.path },
                {
                  key: "size",
                  label: t("disk.size"),
                  sortValue: (row) => row.size,
                  render: (row) => bytes(row.size),
                },
              ]}
            />
          </div>
        </section>
        <section className="disk-panel">
          <h2>{t("disk.types")}</h2>
          <p className="disk-hint">{t("disk.typesHint")}</p>
          <div className="disk-table">
            <DataTable
              rows={value.types}
              getKey={(row) => row.extension}
              label={t("disk.types")}
              columns={[
                {
                  key: "type",
                  label: t("disk.extension"),
                  render: (row) => (row.extension ? `.${row.extension}` : t("disk.noExtension")),
                },
                {
                  key: "count",
                  label: t("disk.files"),
                  sortValue: (row) => row.count,
                  render: (row) => i18n.number(row.count),
                },
                {
                  key: "size",
                  label: t("disk.size"),
                  sortValue: (row) => row.size,
                  render: (row) => (
                    <div className="disk-size">
                      <span>{bytes(row.size)}</span>
                      <span className="disk-bar" aria-hidden>
                        <i style={{ width: `${usedPercent(row.size, value.total)}%` }} />
                      </span>
                    </div>
                  ),
                },
              ]}
            />
          </div>
        </section>
      </div>
    </>
  );
}

export function TrendView({ samples }: { samples: readonly Sample[] }) {
  const t = useT();
  const i18n = useI18n();
  const points = trendPoints(samples);
  const first = samples[0];
  const last = samples.at(-1);
  const bytes = (size: number) => formatBytes(size, i18n.tag);
  return (
    <section className="disk-panel disk-trend">
      <h2>{t("trend.title")}</h2>
      <p className="disk-hint">{t("trend.hint")}</p>
      {!points ? (
        <p role="status">{t("trend.empty")}</p>
      ) : (
        <>
          <p>
            {t("trend.range", {
              min: bytes(Math.min(...samples.map((value) => value.bytes))),
              max: bytes(Math.max(...samples.map((value) => value.bytes))),
            })}
          </p>
          <svg viewBox="0 0 600 120" role="img" aria-label={t("trend.title")}>
            <polyline
              points={points}
              fill="none"
              stroke="currentColor"
              strokeWidth={3}
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          <p>
            {t("trend.change", {
              value: `${last!.bytes < first!.bytes ? "−" : "+"}${bytes(Math.abs(last!.bytes - first!.bytes))}`,
            })}
          </p>
        </>
      )}
      {samples.length ? (
        <div className="disk-table">
          <DataTable
            rows={[...samples].reverse()}
            getKey={(row) => String(row.at)}
            label={t("trend.samples")}
            columns={[
              {
                key: "at",
                label: t("trend.at"),
                render: (row) => i18n.date(row.at, { dateStyle: "medium", timeStyle: "medium" }),
              },
              { key: "bytes", label: t("disk.size"), render: (row) => bytes(row.bytes) },
            ]}
          />
        </div>
      ) : null}
    </section>
  );
}
