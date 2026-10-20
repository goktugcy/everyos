import type { DesktopAppNetworkRuleView } from "@everyos/shared";
import { Globe, Network, Server } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../../components/ui/button.tsx";
import { Field } from "../../../components/ui/field.tsx";
import { Select } from "../../../components/ui/select.tsx";
import { useApiResource } from "../../../features/system/use-api-resource.ts";
import { api } from "../../../lib/api.ts";
import { usePermissions } from "../../../stores/session-store.ts";
import { useDesktopApps } from "../../desktop-apps/store.ts";
import { requestConfirm } from "../../menus/confirm.tsx";
import { ResourceError } from "../system/parts.tsx";

/**
 * The desktop apps' network policy: the addresses apps holding network:outbound may reach. With
 * `appId`, the rules that apply to that app (its own and those for all apps), and new rules default
 * to it. Only administrators change them.
 */
export function NetworkRules({ appId }: { appId?: string }) {
  const { t } = useTranslation();
  const canChange = usePermissions().includes("settings:manage");
  const names = useDesktopApps((state) => state.names);
  const rules = useApiResource<{ rules: DesktopAppNetworkRuleView[] }>(
    `/desktop-apps/network-rules${appId ? `?appId=${encodeURIComponent(appId)}` : ""}`,
    null,
  );
  const [kind, setKind] = useState<"host" | "cidr">("host");
  const [pattern, setPattern] = useState("");
  const [ports, setPorts] = useState("443");
  const [note, setNote] = useState("");
  const [scope, setScope] = useState<"app" | "all">(appId ? "app" : "all");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const run = async (action: () => Promise<unknown>) => {
    setPending(true);
    setError(null);
    try {
      await action();
      rules.reload();
      return true;
    } catch (caught) {
      setError(caught);
      return false;
    } finally {
      setPending(false);
    }
  };
  const parsedPorts = ports
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number);
  const portsValid =
    parsedPorts.length > 0 &&
    parsedPorts.every((port) => Number.isInteger(port) && port >= 1 && port <= 65_535);
  const add = async () => {
    const added = await run(() =>
      api("/desktop-apps/network-rules", {
        method: "POST",
        body: {
          kind,
          pattern: pattern.trim(),
          ports: [...new Set(parsedPorts)],
          appId: appId && scope === "app" ? appId : null,
          note: note.trim() || null,
        },
      }),
    );
    if (added) {
      setPattern("");
      setNote("");
    }
  };
  const remove = async (rule: DesktopAppNetworkRuleView) => {
    if (
      await requestConfirm({
        title: t("desktopApps.network.removeTitle", { pattern: rule.pattern }),
        body: t("desktopApps.network.removeBody"),
        confirmLabel: t("desktopApps.network.remove"),
        danger: true,
      })
    )
      await run(() =>
        api(`/desktop-apps/network-rules/${rule.id}`, { method: "DELETE", body: {} }),
      );
  };

  return (
    <section className="flex flex-col gap-2" data-testid="desktop-app-network-rules">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-fg">
        <Network className="size-4" aria-hidden />
        {t("desktopApps.network.title")}
      </h3>
      <p className="text-xs text-fg-muted">{t("desktopApps.network.description")}</p>
      <ResourceError error={rules.error} />
      {rules.data && !rules.data.rules.length ? (
        <p className="text-sm text-fg-subtle">{t("desktopApps.network.empty")}</p>
      ) : null}
      <ul className="flex flex-col gap-1.5">
        {rules.data?.rules.map((rule) => (
          <li
            key={rule.id}
            className="glass-inset flex flex-wrap items-center gap-x-3 gap-y-1 rounded-everyos-md px-3 py-2 text-sm"
          >
            {rule.kind === "host" ? (
              <Globe className="size-4 shrink-0 text-fg-muted" aria-hidden />
            ) : (
              <Server className="size-4 shrink-0 text-fg-muted" aria-hidden />
            )}
            <span className="font-mono text-fg">{rule.pattern}</span>
            <span className="text-xs text-fg-muted">
              {t("desktopApps.network.portList", { ports: rule.ports.join(", ") })}
            </span>
            <span className="rounded-full bg-hover/12 px-2 py-0.5 text-[0.68rem] text-fg-muted">
              {!rule.appId
                ? t("desktopApps.network.allApps")
                : appId
                  ? t("desktopApps.network.thisApp")
                  : t("desktopApps.network.onlyApp", { name: names[rule.appId] ?? rule.appId })}
            </span>
            {rule.includesThisServer ? (
              <span className="rounded-full bg-warning/15 px-2 py-0.5 text-[0.68rem] text-warning">
                {t("desktopApps.network.thisServer")}
              </span>
            ) : null}
            {rule.note ? <span className="text-xs text-fg-subtle">{rule.note}</span> : null}
            {canChange ? (
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto"
                disabled={pending}
                onClick={() => void remove(rule)}
              >
                {t("desktopApps.network.remove")}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {canChange ? (
        <form
          className="glass-inset flex flex-col gap-3 rounded-everyos-md p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
            <Select
              label={t("desktopApps.network.kind")}
              value={kind}
              onChange={(value) => {
                setKind(value);
                setPorts(value === "host" ? "443" : "");
              }}
              options={[
                { value: "host", label: t("desktopApps.network.kinds.host") },
                { value: "cidr", label: t("desktopApps.network.kinds.cidr") },
              ]}
            />
            <Field
              label={t("desktopApps.network.pattern")}
              hint={t(
                kind === "host"
                  ? "desktopApps.network.patternHostHint"
                  : "desktopApps.network.patternRangeHint",
              )}
              value={pattern}
              onChange={(event) => setPattern(event.target.value)}
              spellCheck={false}
              autoCapitalize="off"
              required
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label={t("desktopApps.network.ports")}
              hint={t("desktopApps.network.portsHint")}
              value={ports}
              inputMode="numeric"
              onChange={(event) => setPorts(event.target.value)}
              required
            />
            <Field
              label={t("desktopApps.network.note")}
              value={note}
              maxLength={200}
              onChange={(event) => setNote(event.target.value)}
            />
          </div>
          {appId ? (
            <Select
              label={t("desktopApps.network.scope")}
              value={scope}
              onChange={setScope}
              options={[
                { value: "app", label: t("desktopApps.network.thisApp") },
                { value: "all", label: t("desktopApps.network.allApps") },
              ]}
            />
          ) : null}
          <ResourceError error={error} />
          <div className="flex justify-end">
            <Button type="submit" disabled={pending || !pattern.trim() || !portsValid}>
              {t("desktopApps.network.add")}
            </Button>
          </div>
        </form>
      ) : (
        <p className="text-xs text-fg-subtle">{t("desktopApps.network.adminsOnly")}</p>
      )}
    </section>
  );
}
