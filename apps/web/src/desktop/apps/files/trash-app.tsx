import type { TrashEntry } from "@everyos/shared";
import { RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "../../../components/ui/alert.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { errorMessage } from "../../../lib/errors.ts";
import { formatBytes, formatDateTime } from "../../../lib/format.ts";
import { useHasPermission } from "../../../stores/session-store.ts";
import { requestConfirm } from "../../menus/confirm.tsx";
import { LoadingBlock, ResourceError } from "../system/parts.tsx";
import { filesApi, filesChanged } from "./lib.ts";
import { useTrashActions, useTrashListing } from "./trash-status.tsx";

/** Recoverable files, isolated by account even in shared file locations. */
export default function TrashApp() {
  const { t, i18n } = useTranslation();
  const listing = useTrashListing();
  const actions = useTrashActions();
  const canWrite = useHasPermission("files:write");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [acting, setBusy] = useState(false);
  const busy = acting || actions.busy;
  const [error, setError] = useState<unknown>(null);
  const entries = listing.data?.entries ?? [];
  const chosen = entries.filter((item) => selected.has(item.id));

  const act = async (items: TrashEntry[], restore: boolean) => {
    if (
      !restore &&
      !(await requestConfirm({
        title: t("trash.deleteTitle", { count: items.length }),
        body: t("trash.deleteBody"),
        confirmLabel: t("trash.deletePermanently"),
        danger: true,
      }))
    )
      return;
    setBusy(true);
    setError(null);
    try {
      const roots = new Set(items.map((item) => item.root));
      for (const root of roots) {
        const ids = items.filter((item) => item.root === root).map((item) => item.id);
        for (let start = 0; start < ids.length; start += 500)
          await (restore ? filesApi.restoreTrash : filesApi.deleteTrash)(
            root,
            ids.slice(start, start + 500),
          );
      }
      setSelected(new Set());
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
      filesChanged();
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="trash-app">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <Button
          size="sm"
          disabled={!canWrite || busy || chosen.length === 0}
          onClick={() => void act(chosen, true)}
        >
          <RotateCcw className="size-4" aria-hidden />
          {t("trash.restore")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!canWrite || busy || chosen.length === 0}
          onClick={() => void act(chosen, false)}
        >
          <Trash2 className="size-4" aria-hidden />
          {t("trash.deletePermanently")}
        </Button>
        <div className="ml-auto flex gap-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            aria-label={t("common.refresh")}
            onClick={filesChanged}
          >
            <RefreshCw className="size-4" aria-hidden />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={
              !canWrite ||
              busy ||
              (!listing.error && entries.length === 0 && !listing.data?.truncated)
            }
            onClick={async () => {
              setError(null);
              if (await actions.empty()) setSelected(new Set());
            }}
          >
            {t("trash.emptyAction")}
          </Button>
        </div>
      </div>
      <p className="px-4 py-3 text-xs text-fg-muted">{t("trash.intro")}</p>
      {error ? (
        <div className="px-4 pb-3">
          <Alert tone="danger">{errorMessage(t, error)}</Alert>
        </div>
      ) : null}
      <ResourceError error={listing.error} />
      {listing.loading ? <LoadingBlock /> : null}
      {listing.data && !listing.error && !listing.data.truncated && entries.length === 0 ? (
        <p className="p-6 text-center text-sm text-fg-muted">{t("trash.empty")}</p>
      ) : null}
      {listing.data?.truncated ? (
        <p role="status" className="px-4 text-xs text-fg-muted">
          {t("files.truncated")}
        </p>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 bg-surface text-fg-muted">
            <tr>
              <th className="p-3">
                <input
                  type="checkbox"
                  aria-label={t("files.selectAll")}
                  disabled={busy || !entries.length}
                  checked={entries.length > 0 && chosen.length === entries.length}
                  onChange={(event) =>
                    setSelected(new Set(event.target.checked ? entries.map((item) => item.id) : []))
                  }
                />
              </th>
              <th className="p-3">{t("files.columns.name")}</th>
              <th className="p-3">{t("trash.originalLocation")}</th>
              <th className="p-3">{t("trash.deletedAt")}</th>
              <th className="p-3">{t("files.columns.size")}</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((item) => (
              <tr
                key={item.id}
                data-trash-item={item.id}
                aria-selected={selected.has(item.id)}
                className={selected.has(item.id) ? "bg-hover/10" : "hover:bg-hover/5"}
              >
                <td className="border-t border-line p-3">
                  <input
                    type="checkbox"
                    aria-label={t("trash.selectItem", { name: item.name })}
                    disabled={busy}
                    checked={selected.has(item.id)}
                    onChange={(event) =>
                      setSelected((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.add(item.id);
                        else next.delete(item.id);
                        return next;
                      })
                    }
                  />
                </td>
                <td className="border-t border-line p-3 font-medium text-fg">{item.name}</td>
                <td
                  className="max-w-64 truncate border-t border-line p-3 text-fg-muted"
                  title={`${item.root}/${item.path}`}
                >
                  {item.root}/{item.path}
                </td>
                <td className="whitespace-nowrap border-t border-line p-3 text-fg-muted">
                  {formatDateTime(item.deletedAt, i18n.language)}
                </td>
                <td className="border-t border-line p-3 text-fg-muted">
                  {item.type === "directory" ? "—" : formatBytes(item.size, i18n.language)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
