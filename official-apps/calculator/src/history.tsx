import { EmptyState, IconButton, useI18n, useT } from "@everyos/app-ui";
import { History, Trash2 } from "lucide-react";
import { Decimal } from "./decimal.ts";
import { formatResult, toDisplay } from "./format.ts";

export interface HistoryEntry {
  /** Canonical expression ("." decimals). */
  expression: string;
  /** Canonical result. */
  result: string;
  at: number;
}

export function HistoryPanel({
  entries,
  decimal,
  onUse,
  onClear,
}: {
  entries: readonly HistoryEntry[];
  decimal: "." | ",";
  onUse: (canonical: string) => void;
  onClear: () => void;
}) {
  const t = useT();
  const i18n = useI18n();
  return (
    <aside className="calc-history" aria-label={t("history.title")}>
      <div className="calc-history-head">
        <h2>{t("history.title")}</h2>
        <IconButton
          size="sm"
          label={t("history.clear")}
          icon={<Trash2 size={14} aria-hidden />}
          disabled={!entries.length}
          onClick={onClear}
        />
      </div>
      {entries.length ? (
        <ul className="calc-history-list">
          {entries.map((entry) => (
            <li key={`${entry.at}-${entry.expression}`}>
              <button
                type="button"
                className="calc-history-expression"
                title={t("history.useExpression")}
                onClick={() => onUse(entry.expression)}
              >
                {toDisplay(entry.expression, decimal)} =
              </button>
              <button
                type="button"
                className="calc-history-result"
                title={t("history.useResult")}
                onClick={() => onUse(entry.result)}
              >
                {formatResult(Decimal.parse(entry.result), i18n.tag)}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState icon={<History size={26} aria-hidden />} title={t("history.empty")} />
      )}
    </aside>
  );
}
