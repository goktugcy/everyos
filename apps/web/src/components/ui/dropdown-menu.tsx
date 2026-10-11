import { Check } from "lucide-react";
import { DropdownMenu as Menu } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../lib/cn.ts";

export const DropdownMenu = Menu.Root;
export const DropdownMenuTrigger = Menu.Trigger;

export function DropdownMenuContent({
  className,
  sideOffset = 8,
  ...props
}: ComponentProps<typeof Menu.Content>) {
  return (
    <Menu.Portal>
      <Menu.Content
        sideOffset={sideOffset}
        collisionPadding={8}
        className={cn(
          "glass-strong everyos-enter z-50 min-w-56 rounded-everyos-md p-1.5 text-sm",
          className,
        )}
        {...props}
      />
    </Menu.Portal>
  );
}

const itemClass =
  "flex h-9 cursor-default select-none items-center gap-2.5 rounded-[calc(var(--everyos-radius-md)-6px)] px-2.5 text-fg outline-none data-[disabled]:opacity-45 data-[highlighted]:bg-[rgb(var(--everyos-accent)/0.18)]";

export function DropdownMenuItem({
  className,
  icon,
  danger,
  children,
  ...props
}: ComponentProps<typeof Menu.Item> & { icon?: ReactNode; danger?: boolean }) {
  return (
    <Menu.Item className={cn(itemClass, danger && "text-danger", className)} {...props}>
      {icon ? (
        <span className="grid size-4 place-items-center text-fg-subtle [&>svg]:size-4">{icon}</span>
      ) : null}
      <span className="flex-1 truncate">{children}</span>
    </Menu.Item>
  );
}

export function DropdownMenuRadioGroup(props: ComponentProps<typeof Menu.RadioGroup>) {
  return <Menu.RadioGroup {...props} />;
}

export function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: ComponentProps<typeof Menu.RadioItem>) {
  return (
    <Menu.RadioItem className={cn(itemClass, "pl-8", className)} {...props}>
      <span className="absolute left-2.5 grid size-4 place-items-center">
        <Menu.ItemIndicator>
          <Check className="size-4 text-accent" aria-hidden />
        </Menu.ItemIndicator>
      </span>
      {children}
    </Menu.RadioItem>
  );
}

export function DropdownMenuLabel({ className, ...props }: ComponentProps<typeof Menu.Label>) {
  return (
    <Menu.Label
      className={cn("px-2.5 pb-1 pt-1.5 text-xs font-medium text-fg-subtle", className)}
      {...props}
    />
  );
}

export function DropdownMenuSeparator({
  className,
  ...props
}: ComponentProps<typeof Menu.Separator>) {
  return <Menu.Separator className={cn("mx-1 my-1.5 h-px bg-line", className)} {...props} />;
}
