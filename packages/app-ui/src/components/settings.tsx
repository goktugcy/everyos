import type { ReactNode } from "react";

/** A settings page: groups of rows with a label, an optional description and a control. */
export function SettingsPanel({ children }: { children: ReactNode }) {
  return <div className="eui-settings eui-padded">{children}</div>;
}

export function SettingsGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="eui-settings-group" aria-label={title}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

export function SettingRow({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="eui-setting">
      <span className="eui-setting-text">
        <span>{label}</span>
        {description ? <span className="eui-hint">{description}</span> : null}
      </span>
      {children}
    </div>
  );
}
