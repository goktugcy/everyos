import { ArrowDown, ArrowUp } from "lucide-react";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { useT } from "../app.tsx";

/**
 * A long list that renders only the rows in view (fixed `rowHeight`), with keyboard navigation:
 * ↑/↓ move the active row, Enter chooses it.
 */
export function VirtualList<T>({
  items,
  rowHeight = 36,
  render,
  getKey,
  label,
  activeIndex,
  onActivate,
  onChoose,
}: {
  items: readonly T[];
  rowHeight?: number;
  render: (item: T, index: number, active: boolean) => ReactNode;
  getKey: (item: T) => string;
  label: string;
  activeIndex?: number;
  onActivate?: (index: number) => void;
  onChoose?: (item: T, index: number) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState(0);
  const [height, setHeight] = useState(480);
  const first = Math.max(0, Math.floor(scroll / rowHeight) - 8);
  const last = Math.min(items.length, Math.ceil((scroll + height) / rowHeight) + 8);
  const move = (index: number) => {
    const next = Math.max(0, Math.min(items.length - 1, index));
    onActivate?.(next);
    const element = box.current;
    if (!element) return;
    const top = next * rowHeight;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (top + rowHeight > element.scrollTop + element.clientHeight)
      element.scrollTop = top + rowHeight - element.clientHeight;
  };
  return (
    <div
      ref={(element) => {
        box.current = element;
        if (element && element.clientHeight && element.clientHeight !== height)
          setHeight(element.clientHeight);
      }}
      className="eui-virtual"
      role="listbox"
      aria-label={label}
      tabIndex={0}
      aria-activedescendant={
        activeIndex !== undefined && items[activeIndex]
          ? `row-${getKey(items[activeIndex])}`
          : undefined
      }
      onScroll={(event) => setScroll(event.currentTarget.scrollTop)}
      onKeyDown={(event) => {
        const current = activeIndex ?? -1;
        if (event.key === "ArrowDown") move(current + 1);
        else if (event.key === "ArrowUp") move(current - 1);
        else if (event.key === "Home") move(0);
        else if (event.key === "End") move(items.length - 1);
        else if (event.key === "Enter" && items[current]) onChoose?.(items[current], current);
        else return;
        event.preventDefault();
      }}
    >
      <div style={{ height: items.length * rowHeight, position: "relative" }}>
        {items.slice(first, last).map((item, offset) => {
          const index = first + offset;
          return (
            <div
              key={getKey(item)}
              id={`row-${getKey(item)}`}
              role="option"
              aria-selected={index === activeIndex}
              style={{
                position: "absolute",
                top: index * rowHeight,
                left: 0,
                right: 0,
                height: rowHeight,
              }}
            >
              {render(item, index, index === activeIndex)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export interface Column<T> {
  key: string;
  label: string;
  /** What sorting compares (absent: the column does not sort). */
  sortValue?: (row: T) => string | number;
  render: (row: T) => ReactNode;
  width?: number | string;
}

/** A table with sortable columns; it renders the first `limit` rows (people filter for more). */
export function DataTable<T>({
  rows,
  columns,
  getKey,
  label,
  limit = 2000,
  selectedKey,
  onSelect,
}: {
  rows: readonly T[];
  columns: ReadonlyArray<Column<T>>;
  getKey: (row: T) => string;
  label: string;
  limit?: number;
  selectedKey?: string | null;
  onSelect?: (row: T) => void;
}) {
  const t = useT();
  const [sort, setSort] = useState<{ key: string; direction: 1 | -1 } | null>(null);
  const sorted = useMemo(() => {
    const column = columns.find((entry) => entry.key === sort?.key);
    if (!column?.sortValue || !sort) return rows;
    const value = column.sortValue;
    return [...rows].sort((a, b) => {
      const x = value(a);
      const y = value(b);
      return (
        (typeof x === "number" && typeof y === "number"
          ? x - y
          : String(x).localeCompare(String(y))) * sort.direction
      );
    });
  }, [rows, columns, sort]);
  return (
    <table className="eui-table" aria-label={label}>
      <thead>
        <tr>
          {columns.map((column) => {
            const active = sort?.key === column.key;
            return (
              <th
                key={column.key}
                style={column.width === undefined ? undefined : { width: column.width }}
                aria-sort={active ? (sort.direction === 1 ? "ascending" : "descending") : undefined}
              >
                {column.sortValue ? (
                  <button
                    type="button"
                    title={
                      active && sort.direction === 1
                        ? t("ui.sortDescending")
                        : t("ui.sortAscending")
                    }
                    onClick={() =>
                      setSort(
                        active && sort.direction === 1
                          ? { key: column.key, direction: -1 }
                          : { key: column.key, direction: 1 },
                      )
                    }
                  >
                    {column.label}
                    {active ? (
                      sort.direction === 1 ? (
                        <ArrowUp size={12} aria-hidden />
                      ) : (
                        <ArrowDown size={12} aria-hidden />
                      )
                    ) : null}
                  </button>
                ) : (
                  column.label
                )}
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {sorted.slice(0, limit).map((row) => {
          const key = getKey(row);
          return (
            <tr
              key={key}
              aria-selected={selectedKey === key}
              tabIndex={onSelect ? 0 : undefined}
              onClick={onSelect ? () => onSelect(row) : undefined}
              onKeyDown={
                onSelect
                  ? (event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onSelect(row);
                      }
                    }
                  : undefined
              }
            >
              {columns.map((column) => (
                <td key={column.key}>{column.render(row)}</td>
              ))}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** One row of a sidebar or list: a button with a title, optional metadata and trailing content. */
export function ListItem({
  title,
  meta,
  icon,
  trailing,
  selected,
  onClick,
  onContextMenu,
}: {
  title: ReactNode;
  meta?: ReactNode;
  icon?: ReactNode;
  trailing?: ReactNode;
  selected?: boolean;
  onClick?: () => void;
  onContextMenu?: (event: React.MouseEvent) => void;
}) {
  return (
    <button
      type="button"
      className="eui-item"
      aria-current={selected ? "true" : undefined}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      {icon}
      <span className="eui-item-text">
        <span className="eui-item-title">{title}</span>
        {meta ? <span className="eui-item-meta">{meta}</span> : null}
      </span>
      {trailing}
    </button>
  );
}
