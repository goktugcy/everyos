import { Search } from "lucide-react";
import { appTitle } from "../apps/app-title.ts";
import { Dialog } from "radix-ui";
import { useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn.ts";
import { usePermissions } from "../../stores/session-store.ts";
import { AppIcon } from "../apps/app-icon.tsx";
import { allowedApps } from "../apps/registry.ts";
import { buildCommands } from "../commands.tsx";
import { formatShortcut } from "../menus/menu-model.ts";
import { desktop } from "../state/controller.ts";
import { useLauncher } from "./launcher-store.ts";
import { searchEntries } from "./search.ts";

interface Result {
  id: string;
  title: string;
  keywords: readonly string[];
  section: "apps" | "commands";
  icon: ReactNode;
  shortcut?: string;
  run: () => void;
}

/** Launcher and global search (Ctrl/⌘+K or Alt+Space). */
export function Launcher() {
  const { t } = useTranslation();
  const isOpen = useLauncher((state) => state.isOpen);
  const close = useLauncher((state) => state.close);
  const permissions = usePermissions();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  const all = useMemo<Result[]>(() => {
    if (!isOpen) return [];
    const apps: Result[] = allowedApps(permissions).map((app) => ({
      id: `app:${app.id}`,
      title: appTitle(app, t),
      keywords: app.keywords ?? [],
      section: "apps",
      icon: <AppIcon manifest={app} size={28} />,
      run: () => desktop.openApp(app.id),
    }));
    const commands: Result[] = buildCommands(t).map((command) => ({
      id: `cmd:${command.id}`,
      title: command.title,
      keywords: command.keywords,
      section: "commands",
      icon: (
        <span className="grid size-7 place-items-center rounded-everyos-sm bg-hover/10 text-fg-muted [&>svg]:size-4">
          {command.icon}
        </span>
      ),
      ...(command.shortcut ? { shortcut: command.shortcut } : {}),
      run: command.run,
    }));
    return [...apps, ...commands];
  }, [isOpen, permissions, t]);

  const results = useMemo(() => {
    const matched = searchEntries(all, query, 30);
    // Without a query show all apps and only a few commands.
    return query.trim()
      ? matched
      : [
          ...matched.filter((r) => r.section === "apps"),
          ...matched.filter((r) => r.section === "commands").slice(0, 4),
        ];
  }, [all, query]);

  const run = (result: Result | undefined) => {
    if (!result) return;
    close();
    setQuery("");
    result.run();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => Math.min(results.length - 1, index + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => Math.max(0, index - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      run(results[active]);
    }
  };

  const sections: Array<["apps" | "commands", Result[]]> = [
    ["apps", results.filter((r) => r.section === "apps")],
    ["commands", results.filter((r) => r.section === "commands")],
  ];
  let index = -1;

  return (
    <Dialog.Root
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) {
          close();
          setQuery("");
          setActive(0);
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[7000] bg-black/30" />
        <Dialog.Content
          className="glass-strong everyos-enter fixed left-1/2 top-[14vh] z-[7001] flex max-h-[70vh] w-[min(94vw,620px)] -translate-x-1/2 flex-col overflow-hidden rounded-everyos-lg"
          aria-describedby={undefined}
        >
          <Dialog.Title className="sr-only">{t("launcher.title")}</Dialog.Title>
          <div className="flex items-center gap-3 border-b border-line px-4">
            <Search className="size-5 shrink-0 text-fg-subtle" aria-hidden />
            <input
              autoFocus
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
              }}
              onKeyDown={onKeyDown}
              placeholder={t("launcher.placeholder")}
              aria-label={t("launcher.placeholder")}
              role="combobox"
              aria-expanded
              aria-controls="launcher-results"
              aria-activedescendant={results[active] ? `launcher-${results[active].id}` : undefined}
              className="h-14 w-full bg-transparent text-base text-fg outline-none placeholder:text-fg-subtle"
            />
          </div>
          <div
            id="launcher-results"
            role="listbox"
            aria-label={t("launcher.title")}
            className="overflow-y-auto p-2"
          >
            {results.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-fg-muted">
                {t("launcher.noResults")}
              </p>
            ) : null}
            {sections.map(([section, items]) =>
              items.length === 0 ? null : (
                <div
                  key={section}
                  role="group"
                  aria-label={t(`launcher.${section}`)}
                  className="pb-1"
                >
                  <p className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wider text-fg-subtle">
                    {t(`launcher.${section}`)}
                  </p>
                  {items.map((result) => {
                    index++;
                    const position = index;
                    return (
                      <div
                        key={result.id}
                        id={`launcher-${result.id}`}
                        role="option"
                        aria-selected={position === active}
                        onPointerMove={() => setActive(position)}
                        onClick={() => run(result)}
                        className={cn(
                          "flex cursor-default items-center gap-3 rounded-everyos-md px-3 py-2 text-sm",
                          position === active
                            ? "bg-[rgb(var(--everyos-accent)/0.2)] text-fg"
                            : "text-fg-muted",
                        )}
                      >
                        {result.icon}
                        <span className="flex-1 truncate">{result.title}</span>
                        {result.shortcut ? (
                          <kbd className="font-sans text-xs text-fg-subtle">
                            {formatShortcut(result.shortcut)}
                          </kbd>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ),
            )}
          </div>
          <p className="border-t border-line px-4 py-2 text-xs text-fg-subtle">
            {t("launcher.hint")}
          </p>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
