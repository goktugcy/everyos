import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes, Ref } from "react";
import { cn } from "../../lib/cn.ts";
import { Spinner } from "./spinner.tsx";

const buttonVariants = cva(
  "inline-flex select-none items-center justify-center gap-2 whitespace-nowrap font-medium transition-[background,box-shadow,transform,opacity] duration-150 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        primary:
          "bg-[linear-gradient(135deg,rgb(var(--otk-accent)),rgb(var(--otk-accent-strong)))] text-accent-contrast shadow-[0_10px_30px_-12px_rgb(var(--otk-accent-strong)/0.9),inset_0_1px_0_rgb(255_255_255/0.35)] hover:brightness-110",
        secondary: "glass-inset text-fg hover:bg-white/10",
        ghost: "text-fg-muted hover:bg-white/8 hover:text-fg",
        danger:
          "bg-danger/90 text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.25)] hover:bg-danger",
      },
      size: {
        sm: "h-8 rounded-otk-sm px-3 text-sm",
        md: "h-10 rounded-otk-md px-4 text-sm",
        lg: "h-12 rounded-otk-md px-5 text-base",
        icon: "size-9 rounded-otk-sm",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  loading?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

export function Button({
  className,
  variant,
  size,
  loading = false,
  disabled,
  children,
  type,
  ref,
  ...props
}: ButtonProps) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? <Spinner className="size-4" /> : null}
      {children}
    </button>
  );
}
