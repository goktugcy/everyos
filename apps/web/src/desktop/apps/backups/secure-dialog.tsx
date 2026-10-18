import {
  OFFSITE_KINDS,
  type DiskList,
  type DriveAccountView,
  type EncryptedUpload,
  type OffsiteKind,
  type OffsiteView,
} from "@everyos/shared";
import { KeyRound } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "../../../components/ui/alert.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Dialog } from "../../../components/ui/dialog.tsx";
import { Field, PasswordField } from "../../../components/ui/field.tsx";
import { Select } from "../../../components/ui/select.tsx";
import { useApiResource } from "../../../features/system/use-api-resource.ts";
import { api } from "../../../lib/api.ts";
import { errorMessage } from "../../../lib/errors.ts";
import { formatDateTime } from "../../../lib/format.ts";
import { useSessionStore } from "../../../stores/session-store.ts";
import { requestConfirm } from "../../menus/confirm.tsx";
import { Toggle } from "../../menubar/quick-settings.tsx";
import { LoadingBlock, ResourceError } from "../system/parts.tsx";

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3" aria-label={title}>
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold">{title}</h3>
        {hint ? <p className="text-xs leading-relaxed text-fg-muted">{hint}</p> : null}
      </div>
      <div className="glass-inset flex flex-col gap-3 rounded-everyos-lg p-4">{children}</div>
    </section>
  );
}

/** Starts a download from a single-use link the API just issued. */
function follow(url: string, name: string) {
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
}

/** Backups › Encryption and off-site: the passphrase, the server secret and the destination. */
export function SecureDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const [revision, setRevision] = useState(0);
  const resource = useApiResource<OffsiteView>("/backups/offsite", null, revision);
  const reload = () => {
    setRevision((n) => n + 1);
    onSaved();
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t("backups.secure.title")}
      description={t("backups.secure.intro")}
      className="w-[min(94vw,640px)]"
    >
      <div className="flex flex-col gap-6" data-testid="backup-secure">
        <ResourceError error={resource.error} />
        {resource.data ? (
          <>
            <PassphraseSection view={resource.data} onSaved={reload} />
            <TargetSection view={resource.data} onSaved={reload} />
            <SecretKeySection />
          </>
        ) : resource.loading ? (
          <LoadingBlock />
        ) : null}
      </div>
    </Dialog>
  );
}

function PassphraseSection({ view, onSaved }: { view: OffsiteView; onSaved: () => void }) {
  const { t, i18n } = useTranslation();
  const [passphrase, setPassphrase] = useState("");
  const [repeat, setRepeat] = useState("");
  const [password, setPassword] = useState("");
  const [check, setCheck] = useState("");
  const [busy, setBusy] = useState<"save" | "check" | "remove" | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const { encryption } = view;
  const mismatch = repeat.length > 0 && passphrase !== repeat;

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy("save");
    setError(null);
    setNotice(null);
    try {
      await api("/backups/encryption", { method: "PUT", body: { passphrase, password } });
      setPassphrase("");
      setRepeat("");
      setPassword("");
      setNotice({ tone: "success", text: t("backups.secure.passphraseSaved") });
      onSaved();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(null);
    }
  };
  const remove = async () => {
    const ok = await requestConfirm({
      title: t("backups.secure.removeTitle"),
      body: t("backups.secure.removeBody"),
      confirmLabel: t("backups.secure.remove"),
      danger: true,
    });
    if (!ok) return;
    setBusy("remove");
    setError(null);
    setNotice(null);
    try {
      await api("/backups/encryption", { method: "DELETE", body: { password } });
      setPassword("");
      onSaved();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(null);
    }
  };
  const test = async () => {
    setBusy("check");
    setError(null);
    setNotice(null);
    try {
      const { ok } = await api<{ ok: boolean }>("/backups/encryption/check", {
        method: "POST",
        body: { passphrase: check },
      });
      setNotice(
        ok
          ? { tone: "success", text: t("backups.secure.checkOk") }
          : { tone: "danger", text: t("backups.secure.checkWrong") },
      );
      setCheck("");
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Section
      title={t("backups.secure.encryption")}
      hint={
        encryption.configured
          ? t("backups.secure.encryptionOn", {
              date: formatDateTime(encryption.setAt ?? 0, i18n.language),
              user: encryption.setBy ?? "—",
            })
          : t("backups.secure.encryptionOff")
      }
    >
      <form className="flex flex-col gap-3" onSubmit={(event) => void save(event)}>
        <PasswordField
          label={t("backups.secure.passphrase")}
          hint={t("backups.secure.passphraseHint")}
          value={passphrase}
          minLength={12}
          maxLength={1024}
          autoComplete="new-password"
          onChange={(event) => setPassphrase(event.target.value)}
        />
        <PasswordField
          label={t("backups.secure.passphraseRepeat")}
          value={repeat}
          autoComplete="new-password"
          onChange={(event) => setRepeat(event.target.value)}
          {...(mismatch ? { error: t("backups.secure.passphraseMismatch") } : {})}
        />
        <PasswordField
          label={t("backups.secure.accountPassword")}
          value={password}
          autoComplete="current-password"
          onChange={(event) => setPassword(event.target.value)}
        />
        {encryption.configured ? (
          <p className="text-xs text-fg-muted">{t("backups.secure.passphraseChangeHint")}</p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          {encryption.configured ? (
            <Button
              variant="ghost"
              loading={busy === "remove"}
              disabled={!password}
              onClick={() => void remove()}
            >
              {t("backups.secure.remove")}
            </Button>
          ) : null}
          <Button
            type="submit"
            loading={busy === "save"}
            disabled={passphrase.length < 12 || passphrase !== repeat || !password}
          >
            {encryption.configured
              ? t("backups.secure.changePassphrase")
              : t("backups.secure.savePassphrase")}
          </Button>
        </div>
      </form>
      {encryption.configured ? (
        <div className="flex flex-col gap-2 border-t border-line pt-3">
          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <PasswordField
                label={t("backups.secure.check")}
                hint={t("backups.secure.checkHint")}
                value={check}
                autoComplete="off"
                onChange={(event) => setCheck(event.target.value)}
              />
            </div>
          </div>
          <div className="flex justify-end">
            <Button
              variant="secondary"
              loading={busy === "check"}
              disabled={!check}
              onClick={() => void test()}
            >
              {t("backups.secure.check")}
            </Button>
          </div>
        </div>
      ) : null}
      {notice ? <Alert tone={notice.tone}>{notice.text}</Alert> : null}
      {error ? <Alert tone="danger">{errorMessage(t, error)}</Alert> : null}
    </Section>
  );
}

type Kind = OffsiteKind | "none";

function TargetSection({ view, onSaved }: { view: OffsiteView; onSaved: () => void }) {
  const { t } = useTranslation();
  const me = useSessionStore((state) => state.session?.user);
  const current = view.target;
  const [kind, setKind] = useState<Kind>(current?.kind ?? "none");
  const [disk, setDisk] = useState(current?.kind === "disk" ? current.uuid : "");
  const [folder, setFolder] = useState(
    current?.kind === "disk" || current?.kind === "drive" ? current.folder : "EveryOS Backups",
  );
  const s3 = current?.kind === "s3" ? current : null;
  const [endpoint, setEndpoint] = useState(s3?.endpoint ?? "");
  const [region, setRegion] = useState(s3?.region ?? "us-east-1");
  const [bucket, setBucket] = useState(s3?.bucket ?? "");
  const [prefix, setPrefix] = useState(s3?.prefix ?? "everyos/");
  const [pathStyle, setPathStyle] = useState(s3?.pathStyle ?? true);
  const [accessKeyId, setAccessKeyId] = useState(s3?.accessKeyId ?? "");
  const [secret, setSecret] = useState("");
  const [keep, setKeep] = useState(String(view.keep));
  const [auto, setAuto] = useState(view.auto);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const disks = useApiResource<DiskList>(kind === "disk" ? "/system/disks" : null, null);
  const drive = useApiResource<DriveAccountView>(kind === "drive" ? "/drive/account" : null, null);
  const volumes = (disks.data?.disks ?? []).flatMap((device) =>
    device.system
      ? []
      : device.volumes.filter((volume) => volume.uuid && volume.managed && !volume.readOnly),
  );
  const count = Number(keep);
  const ready =
    Number.isInteger(count) &&
    count >= 1 &&
    count <= 100 &&
    Boolean(password) &&
    (kind === "none" ||
      (kind === "disk" && Boolean(disk) && Boolean(folder.trim())) ||
      (kind === "drive" && Boolean(folder.trim())) ||
      (kind === "s3" &&
        Boolean(endpoint && region && bucket && accessKeyId) &&
        (Boolean(secret) || s3 !== null)));

  const target = () => {
    switch (kind) {
      case "none":
        return null;
      case "disk":
        return { kind, uuid: disk, folder: folder.trim() };
      case "drive":
        return { kind, folder: folder.trim() };
      case "s3":
        return {
          kind,
          endpoint: endpoint.trim(),
          region: region.trim(),
          bucket: bucket.trim(),
          prefix: prefix.trim(),
          pathStyle,
          accessKeyId: accessKeyId.trim(),
          ...(secret ? { secretAccessKey: secret } : {}),
        };
    }
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy("save");
    setError(null);
    setNotice(null);
    try {
      await api("/backups/offsite", {
        method: "PUT",
        body: { target: target(), keep: count, auto, password },
      });
      setPassword("");
      setSecret("");
      setNotice(t("backups.secure.targetSaved"));
      onSaved();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(null);
    }
  };
  const test = async () => {
    setBusy("test");
    setError(null);
    setNotice(null);
    try {
      await api("/backups/offsite/test", { method: "POST", body: {} });
      setNotice(t("backups.secure.testOk"));
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Section title={t("backups.secure.target")} hint={t("backups.secure.targetHint")}>
      <form className="flex flex-col gap-3" onSubmit={(event) => void save(event)}>
        {!view.encryption.configured ? (
          <Alert tone="warning">{t("backups.secure.needsPassphrase")}</Alert>
        ) : null}
        <Select
          label={t("backups.secure.target")}
          hideLabel
          value={kind}
          options={(["none", ...OFFSITE_KINDS] as const).map((value) => ({
            value,
            label: t(`backups.secure.kinds.${value}`),
          }))}
          onChange={(value) => {
            setKind(value);
            setNotice(null);
            setError(null);
          }}
        />
        {kind === "disk" ? (
          disks.loading ? (
            <LoadingBlock />
          ) : volumes.length === 0 ? (
            <Alert tone="info">{t("backups.secure.noDisks")}</Alert>
          ) : (
            <>
              <Select
                label={t("backups.secure.disk")}
                value={disk}
                options={[
                  ...(disk ? [] : [{ value: "", label: "—" }]),
                  ...volumes.map((volume) => ({
                    value: volume.uuid!,
                    label: volume.label ? `${volume.label} (${volume.name})` : volume.name,
                  })),
                ]}
                onChange={setDisk}
              />
              <Field
                label={t("backups.secure.folder")}
                value={folder}
                maxLength={100}
                onChange={(event) => setFolder(event.target.value)}
              />
              <p className="text-xs text-fg-muted">
                {t("backups.secure.diskOwner", { user: me?.displayName ?? "—" })}
              </p>
            </>
          )
        ) : null}
        {kind === "s3" ? (
          <>
            <Field
              label={t("backups.secure.endpoint")}
              hint={t("backups.secure.endpointHint")}
              value={endpoint}
              inputMode="url"
              spellCheck={false}
              autoCapitalize="off"
              placeholder="https://s3.eu-central-1.amazonaws.com"
              onChange={(event) => setEndpoint(event.target.value)}
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label={t("backups.secure.region")}
                value={region}
                spellCheck={false}
                autoCapitalize="off"
                onChange={(event) => setRegion(event.target.value)}
              />
              <Field
                label={t("backups.secure.bucket")}
                value={bucket}
                spellCheck={false}
                autoCapitalize="off"
                onChange={(event) => setBucket(event.target.value)}
              />
            </div>
            <Field
              label={t("backups.secure.prefix")}
              value={prefix}
              spellCheck={false}
              autoCapitalize="off"
              onChange={(event) => setPrefix(event.target.value)}
            />
            <label className="flex items-center justify-between gap-3 text-sm">
              <span>{t("backups.secure.pathStyle")}</span>
              <Toggle
                checked={pathStyle}
                onCheckedChange={setPathStyle}
                label={t("backups.secure.pathStyle")}
              />
            </label>
            <Field
              label={t("backups.secure.accessKeyId")}
              value={accessKeyId}
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              onChange={(event) => setAccessKeyId(event.target.value)}
            />
            <PasswordField
              label={t("backups.secure.secretAccessKey")}
              value={secret}
              autoComplete="off"
              {...(s3 ? { placeholder: t("backups.secure.secretKept") } : {})}
              onChange={(event) => setSecret(event.target.value)}
            />
          </>
        ) : null}
        {kind === "drive" ? (
          drive.loading ? (
            <LoadingBlock />
          ) : drive.data?.account?.status === "connected" ? (
            <>
              <Field
                label={t("backups.secure.folder")}
                value={folder}
                maxLength={100}
                onChange={(event) => setFolder(event.target.value)}
              />
              <p className="text-xs text-fg-muted">
                {t("backups.secure.driveConnected", {
                  user: drive.data.account.email,
                })}
              </p>
            </>
          ) : (
            <Alert tone="info">{t("backups.secure.driveNotConnected")}</Alert>
          )
        ) : null}
        {kind !== "none" ? (
          <>
            <Field
              label={t("backups.secure.keep")}
              type="number"
              min={1}
              max={100}
              value={keep}
              onChange={(event) => setKeep(event.target.value)}
            />
            <label className="flex items-center justify-between gap-3 text-sm">
              <span>{t("backups.secure.auto")}</span>
              <Toggle checked={auto} onCheckedChange={setAuto} label={t("backups.secure.auto")} />
            </label>
          </>
        ) : null}
        <PasswordField
          label={t("backups.secure.accountPassword")}
          value={password}
          autoComplete="current-password"
          onChange={(event) => setPassword(event.target.value)}
        />
        {notice ? <Alert tone="success">{notice}</Alert> : null}
        {error ? <Alert tone="danger">{errorMessage(t, error)}</Alert> : null}
        <div className="flex flex-wrap justify-end gap-2">
          {current ? (
            <Button variant="secondary" loading={busy === "test"} onClick={() => void test()}>
              {t("backups.secure.test")}
            </Button>
          ) : null}
          <Button type="submit" loading={busy === "save"} disabled={!ready}>
            {kind === "none" ? t("common.save") : t("backups.secure.saveTarget")}
          </Button>
        </div>
      </form>
    </Section>
  );
}

function SecretKeySection() {
  const { t } = useTranslation();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const download = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { url } = await api<{ url: string }>("/backups/secret-key", {
        method: "POST",
        body: { password },
      });
      follow(url, "secret.key");
      setPassword("");
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title={t("backups.secure.secretKey")} hint={t("backups.secure.secretKeyHint")}>
      <form className="flex flex-col gap-3" onSubmit={(event) => void download(event)}>
        <PasswordField
          label={t("backups.secure.accountPassword")}
          value={password}
          autoComplete="current-password"
          onChange={(event) => setPassword(event.target.value)}
        />
        {error ? <Alert tone="danger">{errorMessage(t, error)}</Alert> : null}
        <div className="flex justify-end">
          <Button type="submit" variant="secondary" loading={busy} disabled={!password}>
            <KeyRound className="size-4" aria-hidden />
            {t("backups.secure.secretKeyDownload")}
          </Button>
        </div>
      </form>
    </Section>
  );
}

/** Asks for the passphrase of an uploaded encrypted backup. */
export function DecryptDialog({
  upload,
  onClose,
  onImported,
}: {
  upload: EncryptedUpload;
  onClose: () => void;
  onImported: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const cancel = () => {
    void api(`/backups/upload/${upload.uploadId}`, { method: "DELETE" }).catch(() => undefined);
    onClose();
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/backups/upload/${upload.uploadId}/decrypt`, {
        method: "POST",
        body: { passphrase },
      });
      onImported();
      onClose();
    } catch (caught) {
      setError(caught);
      setPassphrase("");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && cancel()}
      title={t("backups.secure.decryptTitle")}
      description={t("backups.secure.decryptIntro", {
        host: upload.hostname,
        date: formatDateTime(upload.createdAt, i18n.language),
        version: upload.everyosVersion,
      })}
    >
      <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
        <Alert tone="info">
          {upload.includesKey ? t("backups.secure.decryptKey") : t("backups.secure.decryptNoKey")}
        </Alert>
        <PasswordField
          label={t("backups.secure.encryption")}
          value={passphrase}
          autoComplete="off"
          autoFocus
          onChange={(event) => setPassphrase(event.target.value)}
        />
        {error ? <Alert tone="danger">{errorMessage(t, error)}</Alert> : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={cancel}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" loading={busy} disabled={!passphrase}>
            {t("backups.secure.decrypt")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
