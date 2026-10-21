import { PanelLeft } from "lucide-react";
import { useState, type CSSProperties, type ReactNode } from "react";
import { useT } from "../app.tsx";
import { useNarrow } from "../hooks.ts";
import { IconButton } from "./controls.tsx";

export function Toolbar({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <div className="eui-toolbar" role="toolbar" aria-label={label}>
      {children}
    </div>
  );
}

export function ToolbarTitle({ children }: { children: ReactNode }) {
  return <h1 className="eui-toolbar-title">{children}</h1>;
}

export const Spacer = () => <span className="eui-spacer" />;
export const Divider = () => <span className="eui-divider" role="separator" />;

/**
 * The window layout: a toolbar on top, an optional sidebar (a drawer on narrow windows, toggled by
 * the toolbar's sidebar button) and the content.
 */
export function Shell({
  toolbar,
  sidebar,
  sidebarWidth = 240,
  children,
}: {
  toolbar: (sidebarButton: ReactNode) => ReactNode;
  sidebar?: ReactNode;
  sidebarWidth?: number;
  children: ReactNode;
}) {
  const t = useT();
  const narrow = useNarrow();
  const [open, setOpen] = useState(false);
  const button =
    sidebar && narrow ? (
      <IconButton
        label={open ? t("ui.hideSidebar") : t("ui.showSidebar")}
        icon={<PanelLeft size={16} aria-hidden />}
        pressed={open}
        onClick={() => setOpen((value) => !value)}
      />
    ) : null;
  return (
    <div className="eui-shell">
      {toolbar(button)}
      <div
        className={[
          "eui-shell-body",
          sidebar ? "" : "eui-no-sidebar",
          open ? "eui-sidebar-open" : "",
        ].join(" ")}
        style={{ "--eui-sidebar": `${sidebarWidth}px` } as CSSProperties}
        onClick={(event) => {
          // Choosing something in the drawer closes it on narrow windows.
          if (narrow && open && (event.target as HTMLElement).closest(".eui-sidebar button"))
            setOpen(false);
        }}
      >
        {sidebar ? (
          <nav className="eui-sidebar" aria-label={t("ui.more")}>
            {sidebar}
          </nav>
        ) : null}
        <main className="eui-content">{children}</main>
      </div>
    </div>
  );
}

export function SplitView({ children }: { children: [ReactNode, ReactNode] }) {
  return <div className="eui-split">{children}</div>;
}

export function Stack({ children, gap }: { children: ReactNode; gap?: number }) {
  return (
    <div className="eui-stack" style={gap === undefined ? undefined : { gap }}>
      {children}
    </div>
  );
}

export function Row({ children }: { children: ReactNode }) {
  return <div className="eui-row">{children}</div>;
}
