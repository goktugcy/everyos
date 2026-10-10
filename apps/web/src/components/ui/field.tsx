import { Eye, EyeOff } from "lucide-react";
import { useId, useState, type InputHTMLAttributes, type ReactNode, type Ref } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn.ts";

export const inputClassName =
  "glass-inset h-11 w-full rounded-otk-md px-3.5 text-[0.95rem] text-fg placeholder:text-fg-subtle/80 transition-[border-color,box-shadow] duration-150 focus-visible:outline-none focus-visible:border-accent/70 focus-visible:shadow-[0_0_0_3px_rgb(var(--otk-accent)/0.25)] aria-[invalid=true]:border-danger/70";

export interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "id"> {
  label: string;
  hint?: ReactNode;
  error?: ReactNode;
  trailing?: ReactNode;
  ref?: Ref<HTMLInputElement>;
}

/** Labelled input with hint and error text wired up for assistive technology. */
export function Field({ label, hint, error, trailing, className, ref, ...props }: FieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[0.8rem] font-medium tracking-wide text-fg-muted">
        {label}
      </label>
      <div className="relative">
        <input
          ref={ref}
          id={id}
          aria-invalid={error ? true : undefined}
          aria-describedby={[hintId, errorId].filter(Boolean).join(" ") || undefined}
          className={cn(inputClassName, trailing ? "pr-11" : undefined, className)}
          {...props}
        />
        {trailing ? (
          <div className="absolute inset-y-0 right-1 flex items-center">{trailing}</div>
        ) : null}
      </div>
      {hint && !error ? (
        <p id={hintId} className="text-xs leading-relaxed text-fg-subtle">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-xs leading-relaxed text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function PasswordField(props: Omit<FieldProps, "type" | "trailing">) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  return (
    <Field
      {...props}
      type={visible ? "text" : "password"}
      spellCheck={false}
      autoCapitalize="off"
      trailing={
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          className="grid size-9 place-items-center rounded-otk-sm text-fg-subtle hover:bg-hover/8 hover:text-fg"
          aria-label={visible ? t("common.hidePassword") : t("common.showPassword")}
          aria-pressed={visible}
        >
          {visible ? (
            <EyeOff className="size-4" aria-hidden />
          ) : (
            <Eye className="size-4" aria-hidden />
          )}
        </button>
      }
    />
  );
}
