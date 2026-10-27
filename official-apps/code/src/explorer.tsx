import {
  EmptyState,
  errorMessage,
  IconButton,
  LoadingState,
  useApp,
  useT,
  useToast,
} from "@everyos/app-ui";
import {
  ChevronDown,
  ChevronRight,
  FilePlus,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  RefreshCw,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { NameError, parentOf, type Entry, type Workspace } from "./workspace.ts";

type Listing = { entries: Entry[]; more: number } | "loading" | { error: unknown };

interface Row {
  entry: Entry;
  depth: number;
}

/**
 * The workspace folder as a tree: folders load when opened; arrows move, Right/Left open and
 * close folders, Enter opens a file.
 */
export function Explorer({
  workspace,
  activePath,
  expanded,
  onExpanded,
  onOpenFile,
  onClose,
}: {
  workspace: Workspace;
  activePath: string | null;
  expanded: readonly string[];
  onExpanded: (paths: string[]) => void;
  onOpenFile: (entry: Entry) => void;
  onClose: () => void;
}) {
  const app = useApp();
  const t = useT();
  const toast = useToast();
  const [listings, setListings] = useState<Map<string, Listing>>(() => new Map());
  const [selected, setSelected] = useState<string | null>(null);
  const tree = useRef<HTMLUListElement>(null);
  const open = new Set(expanded);

  const load = useCallback(
    async (folder: string) => {
      setListings((current) => new Map(current).set(folder, "loading"));
      try {
        const listing = await workspace.list(folder);
        setListings((current) => new Map(current).set(folder, listing));
      } catch (error) {
        setListings((current) => new Map(current).set(folder, { error }));
      }
    },
    [workspace],
  );

  // The root, and every folder that was open last time.
  useEffect(() => {
    setListings(new Map());
    void load("");
    for (const folder of expanded) void load(folder);
    // Only when the workspace changes; later folders load as they open.
  }, [workspace]);

  const rows: Row[] = [];
  const walk = (folder: string, depth: number) => {
    const listing = listings.get(folder);
    if (!listing || listing === "loading" || "error" in listing) return;
    for (const entry of listing.entries) {
      rows.push({ entry, depth });
      if (entry.kind === "directory" && open.has(entry.path)) walk(entry.path, depth + 1);
    }
  };
  walk("", 0);

  const toggle = (entry: Entry, to = !open.has(entry.path)) => {
    if (entry.kind !== "directory") return;
    if (to) {
      onExpanded([...expanded.filter((path) => path !== entry.path), entry.path]);
      if (!listings.has(entry.path)) void load(entry.path);
    } else
      onExpanded(
        expanded.filter((path) => path !== entry.path && !path.startsWith(`${entry.path}/`)),
      );
  };

  const activate = (entry: Entry) => {
    setSelected(entry.path);
    if (entry.kind === "directory") toggle(entry);
    else onOpenFile(entry);
  };

  // New files and folders go in the selected folder (or the selected file's folder).
  const targetFolder = () => {
    const entry = rows.find((row) => row.entry.path === selected)?.entry;
    if (!entry) return "";
    return entry.kind === "directory" ? entry.path : parentOf(entry.path);
  };

  const create = async (kind: "file" | "directory") => {
    const folder = targetFolder();
    const name = await app.dialogs.prompt(
      kind === "file" ? t("explorer.newFileTitle") : t("explorer.newFolderTitle"),
      folder ? t("explorer.inFolder", { folder }) : t("explorer.inRoot", { name: workspace.name }),
      { placeholder: kind === "file" ? "index.ts" : "src" },
    );
    if (name === null) return;
    try {
      const entry = await workspace.create(folder, name, kind);
      if (folder && !open.has(folder)) onExpanded([...expanded, folder]);
      await load(folder);
      setSelected(entry.path);
      if (kind === "file") onOpenFile(entry);
    } catch (error) {
      toast(
        error instanceof NameError
          ? t(`explorer.names.${error.problem}`, { name: name.trim() })
          : errorMessage(t, error),
        "danger",
      );
    }
  };

  const focusRow = (path: string) => {
    setSelected(path);
    requestAnimationFrame(() =>
      tree.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`)?.focus(),
    );
  };

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const index = rows.findIndex((row) => row.entry.path === selected);
    const row = rows[index];
    const move = (to: number) => {
      const target = rows[Math.max(0, Math.min(rows.length - 1, to))];
      if (target) focusRow(target.entry.path);
    };
    switch (event.key) {
      case "ArrowDown":
        move(index + 1);
        break;
      case "ArrowUp":
        move(index - 1);
        break;
      case "Home":
        move(0);
        break;
      case "End":
        move(rows.length - 1);
        break;
      case "ArrowRight":
        if (!row || row.entry.kind !== "directory") return;
        if (!open.has(row.entry.path)) toggle(row.entry, true);
        else move(index + 1);
        break;
      case "ArrowLeft":
        if (!row) return;
        if (row.entry.kind === "directory" && open.has(row.entry.path)) toggle(row.entry, false);
        else if (parentOf(row.entry.path)) focusRow(parentOf(row.entry.path));
        break;
      case "Enter":
        if (row) activate(row.entry);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const root = listings.get("");
  const focusable =
    selected && rows.some((row) => row.entry.path === selected) ? selected : rows[0]?.entry.path;

  return (
    <nav className="code-explorer" aria-label={t("explorer.label")}>
      <div className="code-explorer-head">
        <FolderOpen size={14} aria-hidden />
        <strong title={workspace.name}>{workspace.name}</strong>
        <span className="code-spacer" />
        {workspace.writable ? (
          <>
            <IconButton
              size="sm"
              label={t("explorer.newFile")}
              icon={<FilePlus size={14} aria-hidden />}
              onClick={() => void create("file")}
            />
            <IconButton
              size="sm"
              label={t("explorer.newFolder")}
              icon={<FolderPlus size={14} aria-hidden />}
              onClick={() => void create("directory")}
            />
          </>
        ) : null}
        <IconButton
          size="sm"
          label={t("explorer.refresh")}
          icon={<RefreshCw size={14} aria-hidden />}
          onClick={() => {
            void load("");
            for (const folder of expanded) void load(folder);
          }}
        />
        <IconButton
          size="sm"
          label={t("explorer.close")}
          icon={<X size={14} aria-hidden />}
          onClick={onClose}
        />
      </div>
      {!root || root === "loading" ? (
        <LoadingState />
      ) : "error" in root ? (
        <EmptyState title={t("explorer.unreadable")} text={errorMessage(t, root.error)} />
      ) : rows.length === 0 ? (
        <EmptyState title={t("explorer.empty")} />
      ) : (
        <ul
          ref={tree}
          className="code-tree"
          role="tree"
          aria-label={workspace.name}
          onKeyDown={onKeyDown}
        >
          {rows.map(({ entry, depth }) => {
            const isOpen = open.has(entry.path);
            const listing = listings.get(entry.path);
            const more =
              entry.kind === "directory" &&
              isOpen &&
              listing &&
              listing !== "loading" &&
              !("error" in listing)
                ? listing.more
                : 0;
            return (
              <li
                key={entry.path}
                role="treeitem"
                data-path={entry.path}
                aria-level={depth + 1}
                aria-expanded={entry.kind === "directory" ? isOpen : undefined}
                aria-selected={entry.path === selected}
                data-active={entry.path === activePath || undefined}
                tabIndex={entry.path === focusable ? 0 : -1}
                className="code-tree-row"
                style={{ paddingInlineStart: `${8 + depth * 14}px` }}
                onClick={() => activate(entry)}
                onFocus={() => setSelected(entry.path)}
                title={entry.path}
              >
                {entry.kind === "directory" ? (
                  <>
                    {isOpen ? (
                      <ChevronDown size={13} aria-hidden />
                    ) : (
                      <ChevronRight size={13} aria-hidden />
                    )}
                    <Folder size={14} aria-hidden />
                  </>
                ) : (
                  <>
                    <span className="code-tree-indent" />
                    <FileText size={14} aria-hidden />
                  </>
                )}
                <span className="code-tree-name">{entry.name}</span>
                {listing === "loading" ? <span className="code-tree-note">…</span> : null}
                {listing && listing !== "loading" && "error" in listing ? (
                  <span className="code-tree-note" title={errorMessage(t, listing.error)}>
                    {t("explorer.unreadableShort")}
                  </span>
                ) : null}
                {more ? (
                  <span className="code-tree-note">{t("explorer.more", { count: more })}</span>
                ) : null}
              </li>
            );
          })}
          {root.more ? (
            <li role="none" className="code-tree-note">
              {t("explorer.more", { count: root.more })}
            </li>
          ) : null}
        </ul>
      )}
    </nav>
  );
}
