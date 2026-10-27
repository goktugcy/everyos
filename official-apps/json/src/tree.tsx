import {
  errorMessage,
  IconButton,
  SearchInput,
  useApp,
  useI18n,
  useT,
  useToast,
} from "@everyos/app-ui";
import { ChevronDown, ChevronRight, ChevronUp, Copy, Route } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { pathString, typeOf, type Json, type PathSegment } from "./json.ts";

/*
 * The document as a tree: only expanded nodes become rows, and only the rows in view are drawn,
 * so documents of many megabytes stay responsive.
 */

const ROW = 26;

interface Row {
  key: string;
  path: PathSegment[];
  label: string | number | null;
  value: Json;
  depth: number;
  expandable: boolean;
  size: number;
}

const keyOf = (path: readonly PathSegment[]) => JSON.stringify(path);

function rowsOf(value: Json, expanded: ReadonlySet<string>): Row[] {
  const rows: Row[] = [];
  const walk = (node: Json, path: PathSegment[], label: string | number | null, depth: number) => {
    const entries =
      node && typeof node === "object"
        ? Array.isArray(node)
          ? node.map((child, index) => [index, child] as const)
          : Object.entries(node)
        : [];
    const key = keyOf(path);
    rows.push({
      key,
      path,
      label,
      value: node,
      depth,
      expandable: entries.length > 0,
      size: entries.length,
    });
    if (entries.length && expanded.has(key))
      for (const [childKey, child] of entries)
        walk(child, [...path, childKey], childKey, depth + 1);
  };
  walk(value, [], null, 0);
  return rows;
}

/** Paths whose name or plain value contains the query (case-insensitive), at most 5,000. */
function searchPaths(value: Json, query: string): PathSegment[][] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const found: PathSegment[][] = [];
  const walk = (node: Json, path: PathSegment[]) => {
    if (found.length >= 5000) return;
    const label = path.at(-1);
    const own =
      (typeof label === "string" && label.toLowerCase().includes(needle)) ||
      ((node === null || typeof node !== "object") && String(node).toLowerCase().includes(needle));
    if (own) found.push(path);
    if (node && typeof node === "object")
      for (const [key, child] of Array.isArray(node)
        ? node.map((item, index) => [index, item] as const)
        : Object.entries(node))
        walk(child, [...path, key]);
  };
  walk(value, []);
  return found;
}

function preview(
  value: Json,
  t: (key: string, values?: Record<string, string | number>) => string,
): string {
  const type = typeOf(value);
  if (type === "object") return t("tree.members", { count: Object.keys(value as object).length });
  if (type === "array") return t("tree.items", { count: (value as Json[]).length });
  if (typeof value === "string")
    return JSON.stringify(value.length > 200 ? `${value.slice(0, 200)}…` : value);
  return JSON.stringify(value);
}

export function TreeView({
  value,
  reveal,
}: {
  value: Json;
  /** A path to show (expanding its parents), e.g. from a query result. */
  reveal: PathSegment[] | null;
}) {
  const t = useT();
  const i18n = useI18n();
  const toast = useToast();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([keyOf([])]));
  const [active, setActive] = useState(0);
  const [query, setQuery] = useState("");
  const [hit, setHit] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState(0);
  const [height, setHeight] = useState(400);

  const rows = useMemo(() => rowsOf(value, expanded), [value, expanded]);
  const hits = useMemo(() => searchPaths(value, query), [value, query]);

  const scrollTo = (index: number) => {
    const element = box.current;
    if (!element) return;
    const top = index * ROW;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (top + ROW > element.scrollTop + element.clientHeight)
      element.scrollTop = top + ROW - element.clientHeight;
  };

  /** Expands the parents of `path` and makes it the active row. */
  const show = (path: PathSegment[]) => {
    const next = new Set(expanded);
    for (let depth = 0; depth < path.length; depth += 1) next.add(keyOf(path.slice(0, depth)));
    setExpanded(next);
    const index = rowsOf(value, next).findIndex((row) => row.key === keyOf(path));
    if (index >= 0) {
      setActive(index);
      requestAnimationFrame(() => scrollTo(index));
    }
  };

  useEffect(() => {
    if (reveal) show(reveal);
    // Only when asked to reveal something new.
  }, [reveal]);

  useEffect(() => {
    if (hits.length) show(hits[Math.min(hit, hits.length - 1)]!);
    // Follow the search.
  }, [hits, hit]);

  const toggle = (row: Row, open?: boolean) => {
    if (!row.expandable) return;
    const next = new Set(expanded);
    if (open ?? !next.has(row.key)) next.add(row.key);
    else next.delete(row.key);
    setExpanded(next);
  };

  const current = rows[Math.min(active, rows.length - 1)];
  const onKey = (event: KeyboardEvent) => {
    const row = rows[active];
    const move = (index: number) => {
      const next = Math.max(0, Math.min(rows.length - 1, index));
      setActive(next);
      scrollTo(next);
    };
    if (event.key === "ArrowDown") move(active + 1);
    else if (event.key === "ArrowUp") move(active - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(rows.length - 1);
    else if (event.key === "ArrowRight" && row) {
      if (row.expandable && !expanded.has(row.key)) toggle(row, true);
      else move(active + 1);
    } else if (event.key === "ArrowLeft" && row) {
      if (row.expandable && expanded.has(row.key)) toggle(row, false);
      else {
        const parent = rows.findIndex((entry) => entry.key === keyOf(row.path.slice(0, -1)));
        if (parent >= 0) move(parent);
      }
    } else if ((event.key === "Enter" || event.key === " ") && row) toggle(row);
    else return;
    event.preventDefault();
  };

  const first = Math.max(0, Math.floor(scroll / ROW) - 10);
  const last = Math.min(rows.length, Math.ceil((scroll + height) / ROW) + 10);
  return (
    <div className="json-tree">
      <div className="json-tree-tools">
        <SearchInput
          value={query}
          onChange={(text) => {
            setQuery(text);
            setHit(0);
          }}
          label={t("tree.search")}
        />
        {query.trim() ? (
          <>
            <span className="json-count" role="status">
              {hits.length
                ? t("tree.hit", { current: Math.min(hit, hits.length - 1) + 1, total: hits.length })
                : t("tree.noHits")}
            </span>
            <IconButton
              size="sm"
              label={t("tree.previous")}
              icon={<ChevronUp size={14} aria-hidden />}
              disabled={!hits.length}
              onClick={() => setHit((index) => (index - 1 + hits.length) % hits.length)}
            />
            <IconButton
              size="sm"
              label={t("tree.next")}
              icon={<ChevronDown size={14} aria-hidden />}
              disabled={!hits.length}
              onClick={() => setHit((index) => (index + 1) % hits.length)}
            />
          </>
        ) : null}
      </div>
      <div className="json-tree-actions">
        <code className="json-path" title={current ? pathString(current.path) : ""}>
          {current ? pathString(current.path) : "$"}
        </code>
        <CopyAction
          label={t("tree.copyPath")}
          icon={<Route size={14} aria-hidden />}
          text={() => (current ? pathString(current.path) : "$")}
          onDone={() => toast(t("ui.copied"))}
        />
        <CopyAction
          label={t("tree.copyValue")}
          icon={<Copy size={14} aria-hidden />}
          text={() => (current ? JSON.stringify(current.value, null, 2) : "")}
          onDone={() => toast(t("ui.copied"))}
        />
      </div>
      <div
        ref={(element) => {
          box.current = element;
          if (element && element.clientHeight && element.clientHeight !== height)
            setHeight(element.clientHeight);
        }}
        className="json-tree-rows"
        role="tree"
        aria-label={t("tree.label")}
        tabIndex={0}
        aria-activedescendant={current ? `node-${active}` : undefined}
        onKeyDown={onKey}
        onScroll={(event) => setScroll(event.currentTarget.scrollTop)}
      >
        <div style={{ height: rows.length * ROW, position: "relative" }}>
          {rows.slice(first, last).map((row, offset) => {
            const index = first + offset;
            const type = typeOf(row.value);
            const open = expanded.has(row.key);
            const isHit =
              hits.length > 0 && keyOf(hits[Math.min(hit, hits.length - 1)]!) === row.key;
            return (
              <div
                key={row.key}
                id={`node-${index}`}
                role="treeitem"
                aria-level={row.depth + 1}
                aria-expanded={row.expandable ? open : undefined}
                aria-selected={index === active}
                className="json-row"
                data-hit={isHit || undefined}
                style={{ top: index * ROW, paddingInlineStart: 6 + row.depth * 16 }}
                onClick={() => {
                  setActive(index);
                  toggle(row);
                }}
              >
                <span className="json-toggle" aria-hidden>
                  {row.expandable ? (
                    open ? (
                      <ChevronDown size={13} />
                    ) : (
                      <ChevronRight size={13} />
                    )
                  ) : null}
                </span>
                {row.label !== null ? (
                  <span className={typeof row.label === "number" ? "json-index" : "json-key"}>
                    {typeof row.label === "number" ? i18n.number(row.label) : row.label}
                  </span>
                ) : (
                  <span className="json-key">$</span>
                )}
                <span className="json-colon">:</span>
                <span className="json-value" data-type={type}>
                  {preview(row.value, t)}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function CopyAction({
  label,
  icon,
  text,
  onDone,
}: {
  label: string;
  icon: React.ReactNode;
  text: () => string;
  onDone: () => void;
}) {
  const app = useApp();
  const t = useT();
  const toast = useToast();
  return (
    <IconButton
      size="sm"
      label={label}
      icon={icon}
      onClick={async () => {
        try {
          await app.clipboard.writeText(text());
          onDone();
        } catch (caught) {
          toast(errorMessage(t, caught), "danger");
        }
      }}
    />
  );
}
