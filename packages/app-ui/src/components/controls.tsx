import { Search, X } from "lucide-react";
import {
  useId,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { useT } from "../app.tsx";

type Variant = "primary" | "secondary" | "ghost" | "danger";

export function Button({
  variant = "secondary",
  size = "md",
  icon,
  children,
  className,
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: "sm" | "md";
  icon?: ReactNode;
}) {
  return (
    <button
      type={type}
      className={["eui-button", className].filter(Boolean).join(" ")}
      data-variant={variant}
      data-size={size}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
}

/** A button with only an icon: `label` names it for screen readers and as its tooltip. */
export function IconButton({
  label,
  icon,
  size = "md",
  pressed,
  variant = "ghost",
  className,
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  label: string;
  icon: ReactNode;
  size?: "sm" | "md";
  pressed?: boolean;
  variant?: Variant;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      className={["eui-button eui-icon-button", className].filter(Boolean).join(" ")}
      data-variant={variant}
      data-size={size}
      {...rest}
    >
      {icon}
    </button>
  );
}

/** A labelled control with an optional hint and error, wired for assistive technology. */
export function Field({
  label,
  hint,
  error,
  children,
  hideLabel,
}: {
  label: string;
  hint?: ReactNode | undefined;
  error?: ReactNode | undefined;
  hideLabel?: boolean | undefined;
  children: (props: {
    id: string;
    "aria-describedby"?: string;
    "aria-invalid"?: boolean;
  }) => ReactNode;
}) {
  const id = useId();
  const described = [hint ? `${id}-hint` : "", error ? `${id}-error` : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="eui-field">
      <label htmlFor={id} className={hideLabel ? "eui-visually-hidden" : "eui-label"}>
        {label}
      </label>
      {children({
        id,
        ...(described ? { "aria-describedby": described } : {}),
        ...(error ? { "aria-invalid": true } : {}),
      })}
      {hint ? (
        <span id={`${id}-hint`} className="eui-hint">
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={`${id}-error`} className="eui-error-text" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

export function TextField({
  label,
  hint,
  error,
  hideLabel,
  mono,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: ReactNode;
  error?: ReactNode;
  hideLabel?: boolean;
  mono?: boolean;
}) {
  return (
    <Field label={label} hint={hint} error={error} hideLabel={hideLabel}>
      {(props) => <input className={`eui-input${mono ? " eui-mono" : ""}`} {...props} {...rest} />}
    </Field>
  );
}

export function TextArea({
  label,
  hint,
  error,
  hideLabel,
  mono,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label: string;
  hint?: ReactNode;
  error?: ReactNode;
  hideLabel?: boolean;
  mono?: boolean;
}) {
  return (
    <Field label={label} hint={hint} error={error} hideLabel={hideLabel}>
      {(props) => (
        <textarea className={`eui-textarea${mono ? " eui-mono" : ""}`} {...props} {...rest} />
      )}
    </Field>
  );
}

export function SearchInput({
  value,
  onChange,
  label,
  placeholder,
  autoFocus,
}: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const t = useT();
  return (
    <div className="eui-search" role="search">
      <Search size={15} aria-hidden />
      <input
        type="search"
        className="eui-input"
        value={value}
        aria-label={label ?? t("ui.search")}
        placeholder={placeholder ?? t("ui.search")}
        autoFocus={autoFocus}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && value) {
            event.stopPropagation();
            onChange("");
          }
        }}
      />
      {value ? (
        <button
          type="button"
          className="eui-button eui-icon-button"
          data-variant="ghost"
          data-size="sm"
          aria-label={t("ui.clear")}
          style={{ position: "absolute", right: 4 }}
          onClick={() => onChange("")}
        >
          <X size={14} aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

export function Select<T extends string>({
  label,
  value,
  options,
  onChange,
  hideLabel,
  ...rest
}: Omit<SelectHTMLAttributes<HTMLSelectElement>, "onChange" | "value"> & {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
  hideLabel?: boolean;
}) {
  return (
    <Field label={label} hideLabel={hideLabel}>
      {(props) => (
        <select
          className="eui-select"
          value={value}
          onChange={(event) => onChange(event.target.value as T)}
          {...props}
          {...rest}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

export function Checkbox({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="eui-check">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

export function Switch({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="eui-switch"
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  );
}

export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "accent" | "success" | "danger" | "warning";
  children: ReactNode;
}) {
  return (
    <span className="eui-badge" data-tone={tone}>
      {children}
    </span>
  );
}

/** Tabs (or a segmented control); with `iconOnly`, tabs show their icon and name it for screen readers. */
export function Tabs<T extends string>({
  label,
  value,
  tabs,
  onChange,
  iconOnly,
}: {
  label: string;
  value: T;
  tabs: ReadonlyArray<{ value: T; label: string; icon?: ReactNode }>;
  onChange: (value: T) => void;
  iconOnly?: boolean;
}) {
  return (
    <div
      className="eui-tabs"
      role="tablist"
      aria-label={label}
      onKeyDown={(event) => {
        const index = tabs.findIndex((tab) => tab.value === value);
        const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
        if (!step) return;
        event.preventDefault();
        const next = tabs[(index + step + tabs.length) % tabs.length]!;
        onChange(next.value);
        event.currentTarget.querySelector<HTMLElement>(`[data-tab="${next.value}"]`)?.focus();
      }}
    >
      {tabs.map((tab) => (
        <button
          key={tab.value}
          type="button"
          role="tab"
          data-tab={tab.value}
          aria-selected={tab.value === value}
          tabIndex={tab.value === value ? 0 : -1}
          className="eui-tab"
          aria-label={iconOnly && tab.icon ? tab.label : undefined}
          title={iconOnly && tab.icon ? tab.label : undefined}
          onClick={() => onChange(tab.value)}
        >
          {tab.icon}
          {iconOnly && tab.icon ? null : tab.label}
        </button>
      ))}
    </div>
  );
}
