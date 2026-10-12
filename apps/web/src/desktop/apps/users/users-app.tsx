import type { TFunction } from "i18next";
import {
  PASSWORD_MIN_LENGTH,
  ROLES,
  type AdminUserView,
  type LinuxBinding,
  type Role,
} from "@everyos/shared";
import {
  KeyRound,
  MoreHorizontal,
  ShieldOff,
  Trash2,
  UserCheck,
  UserPlus,
  UserX,
} from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { LinuxBindingDialog } from "../../../features/account/linux-account.tsx";
import { Alert } from "../../../components/ui/alert.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Dialog } from "../../../components/ui/dialog.tsx";
import { Field, PasswordField } from "../../../components/ui/field.tsx";
import { Select } from "../../../components/ui/select.tsx";
import { Spinner } from "../../../components/ui/spinner.tsx";
import { api } from "../../../lib/api.ts";
import { cn } from "../../../lib/cn.ts";
import { errorMessage, passwordViolations } from "../../../lib/errors.ts";
import { formatDateTime } from "../../../lib/format.ts";
import { useSessionStore } from "../../../stores/session-store.ts";
import type { MenuEntry } from "../../menus/menu-model.ts";
import { MenuDropdown } from "../../menus/menus.tsx";

function useRoleOptions() {
  const { t } = useTranslation();
  return ROLES.map((role) => ({ value: role, label: t(`roles.${role}`) }));
}

function policyError(t: TFunction, error: unknown): string | undefined {
  const violations = passwordViolations(error);
  return violations.length > 0
    ? violations
        .map((v) =>
          t(`validation.passwordPolicy.${v as "too-short"}`, { min: PASSWORD_MIN_LENGTH }),
        )
        .join(" ")
    : undefined;
}

function CreateUserDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const { t } = useTranslation();
  const roles = useRoleOptions();
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("viewer");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/users", {
        method: "POST",
        body: {
          username: username.trim().toLowerCase(),
          displayName: displayName.trim(),
          password,
          role,
        },
      });
      setUsername("");
      setDisplayName("");
      setPassword("");
      setRole("viewer");
      onCreated();
      onOpenChange(false);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };
  const passwordError = policyError(t, error);

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t("users.add")}>
      <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
        <Field
          label={t("users.username")}
          value={username}
          onChange={(e) => setUsername(e.target.value.toLowerCase())}
          hint={t("setup.usernameHint")}
          autoComplete="off"
          required
        />
        <Field
          label={t("users.displayName")}
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          autoComplete="off"
          required
        />
        <PasswordField
          label={t("users.password")}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          hint={t("setup.passwordHint", { min: PASSWORD_MIN_LENGTH })}
          error={passwordError}
          required
        />
        <Select label={t("users.role")} value={role} options={roles} onChange={setRole} />
        {error && !passwordError ? <Alert tone="danger">{errorMessage(t, error)}</Alert> : null}
        <div className="flex justify-end gap-3">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            type="submit"
            loading={busy}
            disabled={!username || !displayName || password.length < PASSWORD_MIN_LENGTH}
          >
            {t("common.create")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function ResetPasswordDialog({
  user,
  onClose,
  onDone,
}: {
  user: AdminUserView | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const passwordError = policyError(t, error);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!user) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/users/${encodeURIComponent(user.id)}/password`, {
        method: "POST",
        body: { newPassword: password },
      });
      setPassword("");
      onDone();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={user !== null}
      onOpenChange={(open) => !open && onClose()}
      title={t("users.resetPassword")}
      description={user ? `${user.displayName} (@${user.username})` : undefined}
    >
      <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
        <PasswordField
          label={t("users.newPassword")}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          hint={t("setup.passwordHint", { min: PASSWORD_MIN_LENGTH })}
          error={passwordError}
          required
        />
        {error && !passwordError ? <Alert tone="danger">{errorMessage(t, error)}</Alert> : null}
        <div className="flex justify-end gap-3">
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" loading={busy} disabled={password.length < PASSWORD_MIN_LENGTH}>
            {t("users.resetPassword")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** User administration (requires users:manage; enforced by the API). */
export default function UsersApp() {
  const { t, i18n } = useTranslation();
  const me = useSessionStore((state) => state.session?.user.id);
  const [users, setUsers] = useState<AdminUserView[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [linking, setLinking] = useState<AdminUserView | null>(null);
  const [bindings, setBindings] = useState<LinuxBinding[]>([]);
  const [resetting, setResetting] = useState<AdminUserView | null>(null);
  const [revision, setRevision] = useState(0);
  const reload = () => setRevision((value) => value + 1);

  useEffect(() => {
    const controller = new AbortController();
    api<{ users: AdminUserView[] }>("/users", { signal: controller.signal }).then(
      (result) => setUsers(result.users),
      (caught: unknown) => !controller.signal.aborted && setError(caught),
    );
    void api<{ bindings: LinuxBinding[] }>("/users/linux-accounts", {
      signal: controller.signal,
    }).then(
      (result) => setBindings(result.bindings),
      () => undefined,
    );
    return () => controller.abort();
  }, [revision]);

  const act = async (action: () => Promise<unknown>, message: string) => {
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(message);
      reload();
    } catch (caught) {
      setError(caught);
    }
  };

  const menuFor = (user: AdminUserView): MenuEntry[] => {
    const self = user.id === me;
    const path = `/users/${encodeURIComponent(user.id)}`;
    return [
      {
        kind: "item",
        id: "linux-account",
        label: t("linux.link"),
        icon: <UserCheck />,
        onSelect: () => setLinking(user),
      },
      {
        kind: "item",
        id: "password",
        label: t("users.resetPassword"),
        icon: <KeyRound />,
        onSelect: () => setResetting(user),
      },
      {
        kind: "item",
        id: "totp",
        label: t("users.resetTotp"),
        icon: <ShieldOff />,
        disabled: self || !user.totpEnabled,
        confirm: {
          title: t("users.resetTotpConfirm.title"),
          body: t("users.resetTotpConfirm.body", { name: user.displayName }),
          confirmLabel: t("users.resetTotpConfirm.confirm"),
        },
        onSelect: () =>
          void act(() => api(`${path}/totp/reset`, { method: "POST" }), t("users.totpReset")),
      },
      {
        kind: "item",
        id: "toggle",
        label: user.disabled ? t("users.enable") : t("users.disable"),
        icon: user.disabled ? <UserCheck /> : <UserX />,
        disabled: self,
        onSelect: () =>
          void act(
            () => api(path, { method: "PATCH", body: { disabled: !user.disabled } }),
            t("users.updated"),
          ),
      },
      { kind: "separator", id: "s" },
      {
        kind: "item",
        id: "delete",
        label: t("common.delete"),
        icon: <Trash2 />,
        danger: true,
        disabled: self,
        confirm: {
          title: t("users.deleteConfirm.title"),
          body: t("users.deleteConfirm.body", { name: user.displayName }),
          confirmLabel: t("users.deleteConfirm.confirm"),
        },
        onSelect: () => void act(() => api(path, { method: "DELETE" }), t("users.deleted")),
      },
    ];
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-line p-3">
        <div className="min-h-9 flex-1">
          {notice ? <Alert tone="success">{notice}</Alert> : null}
          {error ? <Alert tone="danger">{errorMessage(t, error)}</Alert> : null}
        </div>
        <Button size="sm" onClick={() => setCreating(true)}>
          <UserPlus className="size-4" aria-hidden />
          {t("users.add")}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {users === null && !error ? (
          <div className="flex justify-center p-8">
            <Spinner className="size-5 text-fg-subtle" label={t("common.loading")} />
          </div>
        ) : null}
        {users ? (
          <table className="w-full min-w-[680px] border-collapse text-left text-sm">
            <thead className="sticky top-0 bg-[rgb(var(--everyos-surface)/0.95)] text-xs uppercase tracking-wider text-fg-muted">
              <tr>
                <th scope="col" className="px-4 py-2 font-semibold">
                  {t("users.displayName")}
                </th>
                <th scope="col" className="px-4 py-2 font-semibold">
                  {t("users.role")}
                </th>
                <th scope="col" className="px-4 py-2 font-semibold">
                  {t("users.status")}
                </th>
                <th scope="col" className="px-4 py-2 font-semibold">
                  {t("linux.account")}
                </th>
                <th scope="col" className="px-4 py-2 font-semibold">
                  {t("users.twoFactor")}
                </th>
                <th scope="col" className="px-4 py-2 font-semibold">
                  {t("users.lastLogin")}
                </th>
                <th scope="col" className="px-4 py-2">
                  <span className="sr-only">{t("users.actions")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => {
                const self = user.id === me;
                return (
                  <tr key={user.id} className="border-b border-line" data-username={user.username}>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-3">
                        <span className="grid size-8 shrink-0 place-items-center rounded-full button-accent text-xs font-bold">
                          {user.displayName.slice(0, 1).toLocaleUpperCase("tr")}
                        </span>
                        <div className="min-w-0">
                          <p className="truncate font-medium">
                            {user.displayName}{" "}
                            {self ? (
                              <span className="text-xs font-normal text-fg-subtle">
                                ({t("common.you")})
                              </span>
                            ) : null}
                          </p>
                          <p className="truncate text-xs text-fg-muted">@{user.username}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-2.5">
                      {self ? (
                        t(`roles.${user.role}`)
                      ) : (
                        <Select
                          hideLabel
                          label={`${t("users.changeRole")}: ${user.displayName}`}
                          value={user.role}
                          options={ROLES.map((role) => ({
                            value: role,
                            label: t(`roles.${role}`),
                          }))}
                          onChange={(role) =>
                            void act(
                              () =>
                                api(`/users/${encodeURIComponent(user.id)}`, {
                                  method: "PATCH",
                                  body: { role },
                                }),
                              t("users.updated"),
                            )
                          }
                          className="w-36"
                        />
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <span
                        className={cn(
                          "rounded-full px-2 py-0.5 text-xs font-semibold",
                          user.disabled ? "bg-danger/15 text-danger" : "bg-success/15 text-success",
                        )}
                      >
                        {user.disabled ? t("users.disabled") : t("users.active")}
                      </span>
                    </td>
                    <td className="px-4 py-2.5">
                      <button
                        type="button"
                        className="text-fg-muted underline-offset-4 hover:underline"
                        onClick={() => setLinking(user)}
                      >
                        {bindings.find((b) => b.userId === user.id)?.account ?? t("linux.unlinked")}
                      </button>
                    </td>
                    <td className="px-4 py-2.5 text-fg-muted">
                      {user.totpEnabled ? t("account.totp.enabled") : t("account.totp.disabled")}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-fg-muted">
                      {user.lastLoginAt
                        ? formatDateTime(user.lastLoginAt, i18n.language)
                        : t("common.never")}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <MenuDropdown
                        align="end"
                        label={`${t("users.actions")}: ${user.displayName}`}
                        entries={menuFor(user)}
                        trigger={
                          <button
                            type="button"
                            className="grid size-8 place-items-center rounded-everyos-sm text-fg-muted hover:bg-hover/10 hover:text-fg"
                          >
                            <MoreHorizontal className="size-4" aria-hidden />
                          </button>
                        }
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : null}
      </div>
      {linking ? (
        <LinuxBindingDialog
          key={linking.id}
          user={linking}
          onClose={() => setLinking(null)}
          onDone={reload}
        />
      ) : null}
      <CreateUserDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={() => {
          setNotice(t("users.created"));
          reload();
        }}
      />
      <ResetPasswordDialog
        user={resetting}
        onClose={() => setResetting(null)}
        onDone={() => {
          setResetting(null);
          setNotice(t("users.passwordReset"));
          reload();
        }}
      />
    </div>
  );
}
