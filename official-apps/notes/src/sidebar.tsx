import { ListItem, useT } from "@everyos/app-ui";
import { Folder, Hash, NotebookText, Pin, Trash2 } from "lucide-react";
import type { NoteMeta } from "./store.ts";

export type View =
  | { kind: "all" }
  | { kind: "pinned" }
  | { kind: "folder"; name: string }
  | { kind: "tag"; name: string }
  | { kind: "trash" };

const same = (a: View, b: View) =>
  a.kind === b.kind && ("name" in a ? a.name : "") === ("name" in b ? b.name : "");

export function Sidebar({
  view,
  notes,
  folders,
  counts,
  onView,
}: {
  view: View;
  notes: readonly NoteMeta[];
  folders: readonly string[];
  counts: { all: number; pinned: number; trash: number };
  onView: (view: View) => void;
}) {
  const t = useT();
  const live = notes.filter((note) => note.deletedAt === null);
  const tags = new Map<string, number>();
  for (const note of live) for (const tag of note.tags) tags.set(tag, (tags.get(tag) ?? 0) + 1);
  const item = (target: View, label: string, icon: React.ReactNode, count: number) => (
    <ListItem
      key={`${target.kind}:${"name" in target ? target.name : ""}`}
      title={label}
      icon={icon}
      selected={same(view, target)}
      trailing={<span className="notes-count">{count}</span>}
      onClick={() => onView(target)}
    />
  );
  return (
    <div className="notes-sidebar">
      {item({ kind: "all" }, t("views.all"), <NotebookText size={16} aria-hidden />, counts.all)}
      {item({ kind: "pinned" }, t("views.pinned"), <Pin size={16} aria-hidden />, counts.pinned)}
      {folders.length ? <h2 className="notes-heading">{t("views.folders")}</h2> : null}
      {folders.map((name) =>
        item(
          { kind: "folder", name },
          name,
          <Folder size={16} aria-hidden />,
          live.filter((note) => note.folder === name).length,
        ),
      )}
      {tags.size ? <h2 className="notes-heading">{t("views.tags")}</h2> : null}
      {[...tags]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, count]) =>
          item({ kind: "tag", name }, name, <Hash size={16} aria-hidden />, count),
        )}
      <div className="notes-sidebar-end">
        {item({ kind: "trash" }, t("views.trash"), <Trash2 size={16} aria-hidden />, counts.trash)}
      </div>
    </div>
  );
}
