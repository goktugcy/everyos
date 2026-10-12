import { Package } from "lucide-react";
import { useTranslation } from "react-i18next";
import { IconLabel } from "../../../components/ui/icon-label.tsx";
import { FolderIcon } from "./folder-icon.tsx";

/** A native application collection, deliberately excluded from filesystem operations. */
export function ApplicationsEntry({
  view,
  onOpen,
  onSelect,
}: {
  view: "icons" | "list";
  onOpen: () => void;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const button = (
    <button
      type="button"
      className={
        view === "icons"
          ? "group relative flex w-full flex-col items-center gap-1 rounded-lg p-1.5 outline-none hover:z-20 focus:z-20 focus-visible:ring-2 focus-visible:ring-accent"
          : "flex w-full items-center gap-2 rounded px-2 py-1 text-left outline-none hover:bg-hover/5 focus-visible:ring-2 focus-visible:ring-accent"
      }
      aria-label={t("apps.applications")}
      title={t("applications.folder")}
      data-testid="applications-home-entry"
      onClick={onSelect}
      onDoubleClick={onOpen}
      onKeyDown={(event) => {
        if (
          ["Enter", "Delete", "Backspace", "F2"].includes(event.key) ||
          ((event.ctrlKey || event.metaKey) &&
            ["a", "c", "x", "v"].includes(event.key.toLowerCase()))
        )
          event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          onOpen();
        }
      }}
      onDragOver={(event) => {
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "none";
      }}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      {view === "icons" ? (
        <>
          <span className="grid size-[68px] place-items-center rounded-lg group-focus:bg-hover/15">
            <FolderIcon badge={Package} />
          </span>
          <IconLabel text={t("apps.applications")} />
        </>
      ) : (
        <>
          <FolderIcon size={18} badge={Package} />
          <span>{t("apps.applications")}</span>
        </>
      )}
    </button>
  );
  return view === "icons" ? (
    <li>{button}</li>
  ) : (
    <tr className="border-t border-line">
      <td>{button}</td>
      <td colSpan={3} className="px-2 py-1 text-xs text-fg-muted">
        {t("applications.folder")}
      </td>
    </tr>
  );
}
