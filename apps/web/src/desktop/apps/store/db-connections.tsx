import type { DesktopAppDbConnectionView } from "@everyos/shared";
import { Database } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../../components/ui/button.tsx";
import { Dialog } from "../../../components/ui/dialog.tsx";
import { Field } from "../../../components/ui/field.tsx";
import { Select } from "../../../components/ui/select.tsx";
import { useApiResource } from "../../../features/system/use-api-resource.ts";
import { api } from "../../../lib/api.ts";
import { usePermissions } from "../../../stores/session-store.ts";
import { useDesktopApps } from "../../desktop-apps/store.ts";
import { requestConfirm } from "../../menus/confirm.tsx";
import { ResourceError } from "../system/parts.tsx";

const DEFAULT_PORTS = { postgres: 5432, mysql: 3306 } as const;

/**
 * Databases apps holding database:connect may use. Administrators connect them here; the password
 * is typed into EveryOS, sealed on the server and never given to an app. With `appId`, the
 * connections that app may use, and new ones default to it.
 */
export function DbConnections({ appId }: { appId?: string }) {
  const { t } = useTranslation();
  const canChange = usePermissions().includes("settings:manage");
  const names = useDesktopApps((state) => state.names);
  const connections = useApiResource<{ connections: DesktopAppDbConnectionView[] }>(
    `/desktop-apps/db-connections${appId ? `?appId=${encodeURIComponent(appId)}` : ""}`,
    null,
  );
  const [editing, setEditing] = useState<DesktopAppDbConnectionView | "new" | null>(null);
  const [tested, setTested] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const test = async (connection: DesktopAppDbConnectionView) => {
    setPending(connection.id);
    setError(null);
    try {
      const result = await api<{ version: string; ms: number }>(
        `/desktop-apps/db-connections/${connection.id}/test`,
        { method: "POST", body: {} },
      );
      setTested((current) => ({
        ...current,
        [connection.id]: t("desktopApps.database.testOk", {
          version: result.version.split(" ").slice(0, 2).join(" "),
          ms: result.ms,
        }),
      }));
    } catch (caught) {
      setError(caught);
    } finally {
      setPending(null);
    }
  };
  const remove = async (connection: DesktopAppDbConnectionView) => {
    if (
      !(await requestConfirm({
        title: t("desktopApps.database.removeTitle", { name: connection.name }),
        body: t("desktopApps.database.removeBody"),
        confirmLabel: t("desktopApps.database.remove"),
        danger: true,
      }))
    )
      return;
    setError(null);
    try {
      await api(`/desktop-apps/db-connections/${connection.id}`, { method: "DELETE", body: {} });
      connections.reload();
    } catch (caught) {
      setError(caught);
    }
  };

  return (
    <section className="flex flex-col gap-2" data-testid="desktop-app-db-connections">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-fg">
          <Database className="size-4" aria-hidden />
          {t("desktopApps.database.title")}
        </h3>
        {canChange ? (
          <Button size="sm" variant="secondary" onClick={() => setEditing("new")}>
            {t("desktopApps.database.add")}
          </Button>
        ) : null}
      </div>
      <p className="text-xs text-fg-muted">{t("desktopApps.database.description")}</p>
      <ResourceError error={connections.error ?? error} />
      {connections.data && !connections.data.connections.length ? (
        <p className="text-sm text-fg-subtle">{t("desktopApps.database.empty")}</p>
      ) : null}
      <ul className="flex flex-col gap-1.5">
        {connections.data?.connections.map((connection) => (
          <li
            key={connection.id}
            className="glass-inset flex flex-col gap-1 rounded-everyos-md px-3 py-2 text-sm"
          >
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-medium text-fg">{connection.name}</span>
              <span className="text-xs text-fg-muted">
                {t(`desktopApps.database.engines.${connection.engine}`)} ·{" "}
                <span className="font-mono">
                  {connection.username}@{connection.host}:{connection.port}/{connection.database}
                </span>
              </span>
              <span
                className={
                  connection.access === "write"
                    ? "rounded-full bg-warning/15 px-2 py-0.5 text-[0.68rem] text-warning"
                    : "rounded-full bg-hover/12 px-2 py-0.5 text-[0.68rem] text-fg-muted"
                }
              >
                {t(`desktopApps.database.access.${connection.access}`)}
              </span>
              <span className="rounded-full bg-hover/12 px-2 py-0.5 text-[0.68rem] text-fg-muted">
                {t(`desktopApps.database.audience.${connection.audience}`)}
              </span>
              <span className="rounded-full bg-hover/12 px-2 py-0.5 text-[0.68rem] text-fg-muted">
                {!connection.appId
                  ? t("desktopApps.network.allApps")
                  : appId
                    ? t("desktopApps.network.thisApp")
                    : t("desktopApps.network.onlyApp", {
                        name: names[connection.appId] ?? connection.appId,
                      })}
              </span>
            </div>
            {tested[connection.id] ? (
              <p role="status" className="text-xs text-success">
                {tested[connection.id]}
              </p>
            ) : null}
            {canChange ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending === connection.id}
                  onClick={() => void test(connection)}
                >
                  {t("desktopApps.database.test")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing(connection)}>
                  {t("desktopApps.database.edit")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void remove(connection)}>
                  {t("desktopApps.database.remove")}
                </Button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {!canChange ? (
        <p className="text-xs text-fg-subtle">{t("desktopApps.database.adminsOnly")}</p>
      ) : null}
      {editing ? (
        <ConnectionDialog
          connection={editing === "new" ? null : editing}
          appId={appId}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            connections.reload();
          }}
        />
      ) : null}
    </section>
  );
}

function ConnectionDialog({
  connection,
  appId,
  onClose,
  onSaved,
}: {
  connection: DesktopAppDbConnectionView | null;
  appId: string | undefined;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(connection?.name ?? "");
  const [engine, setEngine] = useState<"postgres" | "mysql">(connection?.engine ?? "postgres");
  const [host, setHost] = useState(connection?.host ?? "");
  const [port, setPort] = useState(String(connection?.port ?? DEFAULT_PORTS.postgres));
  const [database, setDatabase] = useState(connection?.database ?? "");
  const [username, setUsername] = useState(connection?.username ?? "");
  const [password, setPassword] = useState("");
  const [tls, setTls] = useState<"disable" | "require" | "verify">(connection?.tls ?? "require");
  const [access, setAccess] = useState<"read" | "write">(connection?.access ?? "read");
  const [audience, setAudience] = useState<"admins" | "everyone">(connection?.audience ?? "admins");
  const [scope, setScope] = useState<"app" | "all">(
    connection ? (connection.appId ? "app" : "all") : appId ? "app" : "all",
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const portNumber = Number(port);

  const save = async () => {
    setPending(true);
    setError(null);
    const body = {
      name: name.trim(),
      engine,
      host: host.trim(),
      port: portNumber,
      database: database.trim(),
      username: username.trim(),
      tls,
      access,
      audience,
      appId: scope === "app" ? (connection?.appId ?? appId ?? null) : null,
      // Editing keeps the stored password unless a new one is typed.
      ...(connection ? (password ? { password } : {}) : { password: password || null }),
    };
    try {
      await api(
        connection
          ? `/desktop-apps/db-connections/${connection.id}`
          : "/desktop-apps/db-connections",
        { method: connection ? "PUT" : "POST", body },
      );
      onSaved();
    } catch (caught) {
      setError(caught);
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={connection ? t("desktopApps.database.editTitle") : t("desktopApps.database.add")}
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <Field
          label={t("desktopApps.database.name")}
          value={name}
          maxLength={80}
          onChange={(event) => setName(event.target.value)}
          required
        />
        <div className="grid gap-3 sm:grid-cols-[10rem_1fr_7rem]">
          <Select
            label={t("desktopApps.database.engine")}
            value={engine}
            onChange={(value) => {
              setEngine(value);
              if (Number(port) === DEFAULT_PORTS[engine]) setPort(String(DEFAULT_PORTS[value]));
            }}
            options={[
              { value: "postgres", label: t("desktopApps.database.engines.postgres") },
              { value: "mysql", label: t("desktopApps.database.engines.mysql") },
            ]}
          />
          <Field
            label={t("desktopApps.database.host")}
            value={host}
            spellCheck={false}
            autoCapitalize="off"
            onChange={(event) => setHost(event.target.value)}
            required
          />
          <Field
            label={t("desktopApps.database.port")}
            value={port}
            inputMode="numeric"
            onChange={(event) => setPort(event.target.value)}
            required
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label={t("desktopApps.database.database")}
            value={database}
            spellCheck={false}
            autoCapitalize="off"
            onChange={(event) => setDatabase(event.target.value)}
            required
          />
          <Field
            label={t("desktopApps.database.username")}
            value={username}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            onChange={(event) => setUsername(event.target.value)}
            required
          />
        </div>
        <Field
          label={t("desktopApps.database.password")}
          hint={
            connection?.hasPassword
              ? t("desktopApps.database.passwordKept")
              : t("desktopApps.database.passwordHint")
          }
          type="password"
          value={password}
          autoComplete="new-password"
          onChange={(event) => setPassword(event.target.value)}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <Select
            label={t("desktopApps.database.tls")}
            value={tls}
            onChange={setTls}
            options={(["require", "verify", "disable"] as const).map((value) => ({
              value,
              label: t(`desktopApps.database.tlsModes.${value}`),
            }))}
          />
          <Select
            label={t("desktopApps.database.accessLabel")}
            value={access}
            onChange={setAccess}
            options={(["read", "write"] as const).map((value) => ({
              value,
              label: t(`desktopApps.database.access.${value}`),
            }))}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Select
            label={t("desktopApps.database.audienceLabel")}
            value={audience}
            onChange={setAudience}
            options={(["admins", "everyone"] as const).map((value) => ({
              value,
              label: t(`desktopApps.database.audience.${value}`),
            }))}
          />
          {appId || connection?.appId ? (
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
        </div>
        {access === "write" ? (
          <p className="text-xs text-warning">{t("desktopApps.database.writeHint")}</p>
        ) : (
          <p className="text-xs text-fg-muted">{t("desktopApps.database.readHint")}</p>
        )}
        <ResourceError error={error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            type="submit"
            disabled={
              pending ||
              !name.trim() ||
              !host.trim() ||
              !database.trim() ||
              !username.trim() ||
              !Number.isInteger(portNumber) ||
              portNumber < 1 ||
              portNumber > 65_535
            }
          >
            {t("common.save")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
