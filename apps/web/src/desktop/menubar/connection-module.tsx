import { useEffect, useState } from "react";
import { Popover } from "radix-ui";
import { useTranslation } from "react-i18next";
import { subscribeApiTraffic, type ApiTraffic } from "../../lib/api-traffic.ts";
import { cn } from "../../lib/cn.ts";
import { formatBytes, formatClock, formatNumber } from "../../lib/format.ts";
import { useSessionStore } from "../../stores/session-store.ts";
import { menubarButton } from "./menubar-button.ts";

export function ConnectionModule() {
  const sessionId = useSessionStore((state) => state.session?.session.id);
  const locked = useSessionStore((state) => state.locked);
  return sessionId && !locked ? <ConnectionDetails key={sessionId} sessionId={sessionId} /> : null;
}

function ConnectionDetails({ sessionId }: { sessionId: string }) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<ApiTraffic[]>([]);
  // Loopback's secure-context exception does not encrypt HTTP. Proxy/backend flags cannot
  // describe the browser-to-proxy hop; the page protocol can.
  const encrypted = window.location.protocol === "https:";
  useEffect(() => {
    if (!open) return;
    return subscribeApiTraffic((entry) => {
      const current = useSessionStore.getState();
      if (current.locked || current.session?.session.id !== sessionId) return;
      setEntries((previous) => [entry, ...previous].slice(0, 12));
    });
  }, [open, sessionId]);
  const label = t(encrypted ? "transport.encrypted" : "transport.unencrypted");
  return (
    <Popover.Root
      open={open}
      onOpenChange={(value) => {
        setEntries([]);
        setOpen(value);
      }}
    >
      <Popover.Trigger
        data-testid="connection-status"
        className={cn(menubarButton, "text-[0.75rem]", encrypted ? "text-success" : "text-warning")}
        aria-label={`${t("transport.title")}: ${label}`}
      >
        {label}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={8}
          collisionPadding={8}
          aria-label={t("transport.title")}
          data-testid="connection-info"
          className="glass-strong everyos-enter z-[8000] flex max-h-[min(520px,80vh)] w-[min(360px,calc(100vw-16px))] flex-col gap-3 overflow-y-auto rounded-everyos-lg p-4 text-sm text-fg"
        >
          <h3 className="font-semibold">
            {t("transport.title")} · {label}
          </h3>
          <p className="text-xs leading-relaxed text-fg-muted">
            {t(encrypted ? "transport.encryptedBody" : "transport.plainBody")}
          </p>
          <div className="flex justify-between border-y border-line py-2 text-xs">
            <span>{t("transport.protocol")}</span>
            <span className="font-mono">{t(encrypted ? "transport.https" : "transport.http")}</span>
          </div>
          <section className="flex flex-col gap-2">
            <h4 className="text-xs font-semibold">
              {t(encrypted ? "transport.encryptedTraffic" : "transport.plainTraffic")}
            </h4>
            <p className="text-xs leading-relaxed text-fg-muted">{t("transport.liveHint")}</p>
            {entries.length === 0 ? (
              <p className="py-3 text-xs text-fg-subtle">{t("transport.waiting")}</p>
            ) : (
              <ol className="flex flex-col gap-2" aria-label={t("transport.requests")}>
                {entries.map((entry, index) => (
                  <li
                    key={`${entry.timestamp}-${index}`}
                    data-traffic-entry
                    className="rounded-everyos-sm border border-line p-2 text-xs"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">
                        {entry.method} · {t(`transport.resources.${entry.resource}`)}
                      </span>
                      <time className="text-fg-subtle">
                        {formatClock(entry.timestamp, i18n.language, true)}
                      </time>
                    </div>
                    <div className="mt-1 flex justify-between gap-2 text-fg-muted">
                      <span>
                        {entry.status
                          ? t("transport.status", { value: entry.status })
                          : t("transport.failed")}
                      </span>
                      <span>
                        {t("transport.duration", {
                          value: formatNumber(entry.durationMs, i18n.language),
                        })}
                      </span>
                    </div>
                    <p className="mt-1 text-fg-muted">
                      {t("transport.sizes", {
                        sent: formatBytes(entry.sentBytes, i18n.language),
                        received:
                          entry.receivedBytes === null
                            ? "—"
                            : formatBytes(entry.receivedBytes, i18n.language),
                      })}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </section>
          <p className="border-t border-line pt-2 text-[0.7rem] leading-relaxed text-fg-subtle">
            {t("transport.payloadHint")}
          </p>
          <Popover.Close className="self-end text-xs text-accent outline-none focus-visible:ring-2 focus-visible:ring-accent">
            {t("common.close")}
          </Popover.Close>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
