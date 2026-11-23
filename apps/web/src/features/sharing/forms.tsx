import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { LinuxAccount, NetworkConnection, NetworkFolderShare } from "@everyos/shared";
import { Dialog } from "../../components/ui/dialog.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Field, PasswordField, inputClassName } from "../../components/ui/field.tsx";
import { Alert } from "../../components/ui/alert.tsx";
import { api } from "../../lib/api.ts";
import { errorMessage } from "../../lib/errors.ts";
import { requestConfirm } from "../../desktop/menus/confirm.tsx";
import { LocationPicker } from "../drive/pickers.tsx";
import type { FileLocation } from "../../desktop/apps/files/lib.ts";
import { filesChanged } from "../../desktop/apps/files/lib.ts";
import { usePermissions } from "../../stores/session-store.ts";

export function Check({
  label,
  value,
  onChange,
}: {
  label: ReactNode;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2 text-sm text-fg-muted">
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-4 shrink-0 accent-[rgb(var(--everyos-accent))]"
      />
      <span>{label}</span>
    </label>
  );
}
export function Select({
  label,
  value,
  onChange,
  children,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5 text-sm text-fg-muted">
      {label}
      <select
        className={inputClassName}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
      >
        {children}
      </select>
    </label>
  );
}
export function ConnectionForm({
  connection,
  preset,
  onClose,
  onSaved,
}: {
  connection?: NetworkConnection | undefined;
  preset?: { protocol: string; host: string; port: number } | undefined;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation(),
    permissions = usePermissions();
  const [protocol, setProtocol] = useState(
    connection?.protocol ??
      (preset?.protocol as "nfs" | "smb" | "sftp" | undefined) ??
      (permissions.includes("system:manage") ? "nfs" : "sftp"),
  );
  const [name, setName] = useState(connection?.name ?? "");
  const [host, setHost] = useState(connection?.host ?? preset?.host ?? "");
  const [port, setPort] = useState(
    connection?.port ?? preset?.port ?? (protocol === "nfs" ? 2049 : protocol === "smb" ? 445 : 22),
  );
  const [path, setPath] = useState(connection?.remotePath ?? (protocol === "smb" ? "" : "/"));
  const [mountName, setMountName] = useState(connection?.mountName ?? "");
  const [username, setUsername] = useState(connection?.username ?? "");
  const [password, setPassword] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [domain, setDomain] = useState("");
  const [readOnly, setReadOnly] = useState(connection?.readOnly ?? true);
  const [enabled, setEnabled] = useState(connection?.enabled ?? true);
  const [persistent, setPersistent] = useState(connection?.persistent ?? false);
  const [automount, setAutomount] = useState(connection?.automount ?? true);
  const [version, setVersion] = useState(
    connection?.version ?? (protocol === "nfs" ? "4.2" : protocol === "smb" ? "3.1.1" : "sftp"),
  );
  const [fingerprint, setFingerprint] = useState(connection?.fingerprint ?? "");
  const [verified, setVerified] = useState(Boolean(connection?.fingerprint));
  const [tested, setTested] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null);
  const changeProtocol = (p: "nfs" | "smb" | "sftp") => {
    setProtocol(p);
    setVersion(p === "nfs" ? "4.2" : p === "smb" ? "3.1.1" : "sftp");
    setPort(p === "nfs" ? 2049 : p === "smb" ? 445 : 22);
    setPath(p === "smb" ? "" : "/");
    setVerified(false);
    setFingerprint("");
  };
  const probe = async () => {
    setBusy(true);
    setError(null);
    setTested(null);
    try {
      const result = await api<{ reachable: boolean; fingerprint: string | null }>(
        "/sharing/probe",
        { method: "POST", body: { host, port, protocol } },
      );
      setTested(result.reachable);
      if (result.fingerprint) {
        setFingerprint(result.fingerprint);
        setVerified(false);
      }
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (protocol === "sftp" && (!verified || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(fingerprint)))
      return;
    if (
      !(await requestConfirm({
        title: t("sharing.confirmTitle"),
        body:
          t("sharing.confirmBody") +
          " " +
          protocol.toUpperCase() +
          " · " +
          host +
          ":" +
          port +
          " · " +
          path +
          " · " +
          username +
          " · " +
          (readOnly ? t("sharing.readOnly") : t("sharing.readWrite")),
        confirmLabel: t("common.save"),
        danger: false,
      }))
    )
      return;
    setBusy(true);
    setError(null);
    try {
      await api("/sharing/connections" + (connection ? "/" + connection.id : ""), {
        method: connection ? "PUT" : "POST",
        body: {
          name,
          protocol,
          host,
          port,
          remotePath: path,
          ...(protocol !== "sftp" && mountName ? { mountName } : {}),
          username,
          readOnly,
          enabled,
          persistent,
          automount,
          version,
          fingerprint: protocol === "sftp" ? fingerprint : null,
          ...(password ? { password } : {}),
          ...(privateKey ? { privateKey } : {}),
          ...(passphrase ? { passphrase } : {}),
          ...(domain ? { domain } : {}),
          confirm: true,
        },
      });
      filesChanged();
      onSaved();
      onClose();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v && !busy) onClose();
      }}
      title={connection ? t("common.edit") : t("sharing.addConnection")}
    >
      <form onSubmit={(e) => void save(e)} className="flex flex-col gap-4">
        {error ? <Alert tone="danger">{errorMessage(t, error)}</Alert> : null}
        <Field
          label={t("sharing.name")}
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={80}
        />
        <Select
          label={t("sharing.protocol")}
          value={protocol}
          disabled={Boolean(connection)}
          onChange={(p) => changeProtocol(p as typeof protocol)}
        >
          {permissions.includes("system:manage") ? (
            <>
              <option value="nfs">NFS</option>
              <option value="smb">SMB</option>
            </>
          ) : null}
          <option value="sftp">SFTP</option>
        </Select>
        <div className="grid grid-cols-[1fr_6rem] gap-3">
          <Field
            label={t("sharing.host")}
            value={host}
            onChange={(e) => {
              setHost(e.target.value);
              setVerified(false);
              setTested(null);
            }}
            required
            maxLength={253}
          />
          <Field
            label={t("sharing.port")}
            type="number"
            min={1}
            max={65535}
            value={port}
            onChange={(e) => {
              setPort(Number(e.target.value));
              setVerified(false);
            }}
            required
          />
        </div>
        <Field
          label={t("sharing.remotePath")}
          value={path}
          onChange={(e) => setPath(e.target.value)}
          required
          maxLength={1024}
        />
        {protocol !== "sftp" ? (
          <Field
            label={t("sharing.mountName")}
            value={mountName}
            onChange={(e) => setMountName(e.target.value)}
            disabled={Boolean(connection)}
            pattern="[A-Za-z0-9][A-Za-z0-9_-]{0,63}"
            maxLength={64}
          />
        ) : null}
        {protocol === "smb" && version === "2.1" ? (
          <Alert tone="warning">{t("sharing.smb2Warning")}</Alert>
        ) : null}
        {protocol !== "nfs" ? (
          <>
            <Field
              label={t("sharing.username")}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              autoComplete="off"
            />
            <PasswordField
              label={t("sharing.password")}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              placeholder={connection ? t("sharing.optional") : ""}
            />
            {protocol === "smb" ? (
              <Field
                label={t("sharing.domain")}
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
              />
            ) : (
              <>
                <label className="flex flex-col gap-1.5 text-sm text-fg-muted">
                  {t("sharing.privateKey")}
                  <textarea
                    className={inputClassName + " h-24 py-2 font-mono text-xs"}
                    value={privateKey}
                    onChange={(e) => setPrivateKey(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={32768}
                  />
                </label>
                <PasswordField
                  label={t("sharing.passphrase")}
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  autoComplete="new-password"
                />
              </>
            )}
          </>
        ) : (
          <Alert tone="warning">{t("sharing.nfsWarning")}</Alert>
        )}
        {protocol !== "sftp" ? (
          <Select
            label={t("common.version", { version: "" })}
            value={version}
            onChange={setVersion}
          >
            {(protocol === "nfs" ? ["4.2", "4.1", "4", "3"] : ["3.1.1", "3.0", "2.1"]).map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </Select>
        ) : null}
        <Button variant="secondary" onClick={() => void probe()} loading={busy} disabled={!host}>
          {protocol === "sftp" ? t("sharing.verifyHostKey") : t("sharing.test")}
        </Button>
        {tested !== null ? (
          <Alert tone={tested ? "info" : "warning"}>
            {tested ? t("sharing.tcpReachable") : t("sharing.unavailable")}
          </Alert>
        ) : null}
        {protocol === "sftp" ? (
          <>
            <Field
              label={t("sharing.fingerprint")}
              value={fingerprint}
              onChange={(e) => {
                setFingerprint(e.target.value);
                setVerified(false);
              }}
              required
              spellCheck={false}
            />
            <Check label={t("sharing.hostKeyHint")} value={verified} onChange={setVerified} />
          </>
        ) : (
          <p className="text-xs text-fg-subtle">{t("sharing.linuxAccountHint")}</p>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Check label={t("sharing.readOnly")} value={readOnly} onChange={setReadOnly} />
          <Check label={t("sharing.enabled")} value={enabled} onChange={setEnabled} />
          {protocol !== "sftp" ? (
            <>
              <Check label={t("sharing.persistent")} value={persistent} onChange={setPersistent} />
              <Check label={t("sharing.automount")} value={automount} onChange={setAutomount} />
            </>
          ) : null}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" loading={busy} disabled={protocol === "sftp" && !verified}>
            {t("common.save")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function FolderShareForm({
  share,
  initialFolder,
  onClose,
  onSaved,
}: {
  share?: NetworkFolderShare | undefined;
  initialFolder?: FileLocation | undefined;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(share?.name ?? "");
  const [protocol, setProtocol] = useState<"nfs" | "smb">(share?.protocol ?? "smb");
  const [folder, setFolder] = useState<FileLocation | null>(
    share ? { root: share.root, path: share.path } : (initialFolder ?? null),
  );
  const [picking, setPicking] = useState(false);
  const [clients, setClients] = useState(share?.clients.join(", ") ?? "");
  const [users, setUsers] = useState<string[]>(share?.users ?? []);
  const [accounts, setAccounts] = useState<LinuxAccount[]>([]);
  const [readOnly, setReadOnly] = useState(share?.readOnly ?? true),
    [enabled, setEnabled] = useState(share?.enabled ?? true);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null);
  useEffect(() => {
    const controller = new AbortController();
    void api<{ accounts: LinuxAccount[] }>("/users/linux-accounts", {
      signal: controller.signal,
    }).then(
      (v) => setAccounts(v.accounts.filter((a) => a.uid >= 1000 && a.uid !== 65534)),
      (e) => {
        if (!controller.signal.aborted) setError(e);
      },
    );
    return () => controller.abort();
  }, []);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!folder) return;
    if (
      !(await requestConfirm({
        title: t("sharing.confirmTitle"),
        body:
          t("sharing.confirmBody") +
          " " +
          folder.root +
          ":" +
          folder.path +
          " · " +
          protocol.toUpperCase() +
          " · " +
          (readOnly ? t("sharing.readOnly") : t("sharing.readWrite")) +
          " · " +
          (protocol === "nfs" ? clients : users.join(", ") || t("sharing.ownerUser")),
        confirmLabel: t("common.save"),
        danger: false,
      }))
    )
      return;
    setBusy(true);
    setError(null);
    try {
      await api("/sharing/folders" + (share ? "/" + share.id : ""), {
        method: share ? "PUT" : "POST",
        body: {
          name,
          protocol,
          ...folder,
          readOnly,
          enabled,
          clients: clients.split(/[,\s]+/).filter(Boolean),
          users,
          confirm: true,
        },
      });
      onSaved();
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Dialog
        open
        onOpenChange={(v) => {
          if (!v && !busy) onClose();
        }}
        title={share ? t("common.edit") : t("sharing.addShare")}
      >
        <form onSubmit={(e) => void save(e)} className="flex flex-col gap-4">
          {error ? <Alert tone="danger">{errorMessage(t, error)}</Alert> : null}
          <Field
            label={t("sharing.name")}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={80}
            pattern="[A-Za-z0-9][A-Za-z0-9 _.-]*"
          />
          <Select
            label={t("sharing.protocol")}
            value={protocol}
            disabled={Boolean(share)}
            onChange={(v) => setProtocol(v as typeof protocol)}
          >
            <option value="smb">SMB</option>
            <option value="nfs">NFS</option>
          </Select>
          <Button variant="secondary" onClick={() => setPicking(true)}>
            {t("sharing.selectFolder")}
          </Button>
          {folder ? (
            <code className="break-all text-xs text-fg-muted">
              {folder.root}:{folder.path || "/"}
            </code>
          ) : null}
          {protocol === "nfs" ? (
            <>
              <Alert tone="warning">
                {t("sharing.nfsWarning")} {t("sharing.nfsOwnerMapping")}
              </Alert>
              <Field
                label={t("sharing.clients")}
                value={clients}
                onChange={(e) => setClients(e.target.value)}
                placeholder="192.168.1.0/24"
                required
              />
            </>
          ) : (
            <>
              <fieldset className="flex max-h-48 flex-col gap-2 overflow-y-auto rounded-everyos-sm border border-line p-3">
                <legend className="px-1 text-sm text-fg-muted">{t("sharing.users")}</legend>
                {accounts.map((a) => (
                  <Check
                    key={a.name}
                    label={a.name}
                    value={users.includes(a.name)}
                    onChange={(checked) =>
                      setUsers((current) =>
                        checked ? [...current, a.name] : current.filter((u) => u !== a.name),
                      )
                    }
                  />
                ))}
                {!users.length ? (
                  <p className="text-xs text-fg-subtle">{t("sharing.ownerUser")}</p>
                ) : null}
              </fieldset>
              <p className="text-xs text-fg-subtle">{t("sharing.smbCredentialHint")}</p>
            </>
          )}
          <Check label={t("sharing.readOnly")} value={readOnly} onChange={setReadOnly} />
          <Check label={t("sharing.enabled")} value={enabled} onChange={setEnabled} />
          <p className="text-xs text-fg-subtle">{t("sharing.linuxAccountHint")}</p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={!folder} loading={busy}>
              {t("common.save")}
            </Button>
          </div>
        </form>
      </Dialog>
      {picking ? (
        <LocationPicker
          title={t("sharing.selectFolder")}
          confirmLabel={t("common.open")}
          allowReadOnly={readOnly}
          localOnly
          onClose={() => setPicking(false)}
          onPick={(value) => {
            setFolder(value);
            setPicking(false);
          }}
        />
      ) : null}
    </>
  );
}
