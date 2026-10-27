import { SSH_KEY_TYPES, isBridgeError, type SshKey } from "@everyos/app-sdk";
import {
  Badge,
  Button,
  DataTable,
  Dialog,
  EmptyState,
  LoadingState,
  SearchInput,
  Select,
  Shell,
  Spacer,
  TextArea,
  TextField,
  Toolbar,
  ToolbarTitle,
  errorMessage,
  useApp,
  useAsync,
  useI18n,
  useT,
  useToast,
} from "@everyos/app-ui";
import { useEffect, useRef, useState } from "react";
import {
  emptyEditor,
  isPrivateInput,
  validateEditor,
  validatePassphrase,
  visibleKeys,
  type Editor,
  type FieldError,
} from "./keys.ts";

const CAPS = ["secrets:ssh", "files:save", "clipboard:write"];
export function KeysApp() {
  const app = useApp();
  const t = useT();
  const i18n = useI18n();
  const toast = useToast();
  const [grants, setGrants] = useState<ReadonlySet<string>>(
    () => new Set(CAPS.filter((cap) => app.permissions.has(cap))),
  );
  const [revision, setRevision] = useState(0);
  const [epoch, setEpoch] = useState(0);
  const [visible, setVisible] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [editor, setEditor] = useState<Editor | null>(null);
  const [privateId, setPrivateId] = useState<string | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [repeated, setRepeated] = useState("");
  const [invalid, setInvalid] = useState<FieldError | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const active = useRef(false);
  const generation = useRef(0);
  const allowed = grants.has("secrets:ssh");
  const list = useAsync(
    async () => ({
      keys: allowed ? (await app.host.call("ssh.keys.list", null)).keys : [],
      at: Date.now(),
    }),
    [app, allowed, revision, epoch],
  );
  const keys = allowed ? (list.data?.keys ?? []) : [];
  const rows = visibleKeys(keys, search, filter);
  const selected = rows.find((key) => key.id === selectedId) ?? rows[0] ?? null;
  const privateKey = allowed
    ? (keys.find((key) => key.id === privateId && key.hasPrivateKey) ?? null)
    : null;
  const clearSecret = () => {
    setPassphrase("");
    setRepeated("");
    setPrivateId(null);
  };
  useEffect(() => {
    const invalidate = () => {
      generation.current++;
      active.current = false;
      setBusy(false);
      clearSecret();
      setError(null);
    };
    const stopGrants = app.permissions.onChange((next) => {
      setGrants(new Set(next));
      setEpoch((value) => value + 1);
      invalidate();
    });
    const stopSuspend = app.lifecycle.onSuspend(() => {
      setVisible(false);
      invalidate();
    });
    const stopResume = app.lifecycle.onResume(() => {
      setVisible(true);
      setRevision((value) => value + 1);
    });
    const stopPage = () => invalidate();
    window.addEventListener("pagehide", stopPage);
    return () => {
      stopGrants();
      stopSuspend();
      stopResume();
      window.removeEventListener("pagehide", stopPage);
      generation.current++;
    };
  }, [app]);
  useEffect(() => {
    if (!visible || list.loading || busy || !allowed) return;
    const timer = setInterval(() => setRevision((value) => value + 1), 15000);
    return () => clearInterval(timer);
  }, [visible, list.loading, busy, allowed]);
  const problem = (cause: unknown) => {
    if (isBridgeError(cause)) {
      if (cause.code === "RATE_LIMITED") return t("keys.cryptoBusy");
      if (cause.code === "HOST_CAPABILITY_UNAVAILABLE") return t("keys.toolMissing");
      if (cause.code === "CONFLICT") return t("keys.conflict");
    }
    return errorMessage(t, cause);
  };
  const run = async (work: (current: number) => Promise<void>) => {
    if (active.current || !app.permissions.has("secrets:ssh")) return;
    const current = generation.current;
    active.current = true;
    setBusy(true);
    setError(null);
    try {
      await work(current);
    } catch (cause) {
      if (current === generation.current && problem(cause)) setError(cause);
    } finally {
      if (current === generation.current) {
        active.current = false;
        setBusy(false);
        setRevision((value) => value + 1);
      }
    }
  };
  const saveEditor = () => {
    if (!editor) return;
    const failure = validateEditor(editor);
    if (failure) {
      setInvalid(failure);
      return;
    }
    const value = editor;
    void run(async (current) => {
      const key =
        value.kind === "generate"
          ? await app.host.call("ssh.keys.generate", {
              name: value.name.trim(),
              type: value.type,
              comment: value.comment.trim(),
            })
          : value.kind === "import"
            ? await app.host.call("ssh.keys.import", {
                name: value.name.trim(),
                publicKey: value.publicKey.trim(),
              })
            : await app.host.call("ssh.keys.update", {
                id: value.id!,
                name: value.name.trim(),
                comment: value.comment.trim(),
              });
      if (current !== generation.current) return;
      setSelectedId(key.id);
      setSearch("");
      setFilter("all");
      setEditor(null);
      setInvalid(null);
      toast(t(`keys.${value.kind}Done`));
    });
  };
  const exportKey = (key: SshKey, secret: string | null) =>
    void run(async (current) => {
      try {
        const result = await app.host.call("ssh.keys.export", {
          id: key.id,
          private: secret !== null,
          ...(secret === null ? {} : { passphrase: secret }),
        });
        if (current !== generation.current || !app.permissions.has("files:save")) return;
        const file = await app.files.save({ suggestedName: result.fileName });
        if (!file || current !== generation.current || !app.permissions.has("secrets:ssh")) return;
        await app.files.write(file, result.text);
        if (current === generation.current) toast(t("keys.exportDone"));
      } finally {
        if (current === generation.current) clearSecret();
      }
    });
  const submitPrivate = () => {
    const failure = validatePassphrase(passphrase, repeated);
    if (failure) {
      setInvalid(failure);
      return;
    }
    const key = privateKey;
    const secret = passphrase;
    clearSecret();
    if (key) exportKey(key, secret);
  };
  const remove = (key: SshKey) =>
    void run(async (current) => {
      if (
        !key.hasPrivateKey &&
        !(await app.dialogs.confirm(
          t("keys.deleteTitle"),
          t("keys.deletePublic", { name: key.name, fingerprint: key.fingerprint }),
          { confirm: t("keys.delete"), destructive: true },
        ))
      )
        return;
      if (current !== generation.current) return;
      // The desktop supplies the mandatory native confirmation for a key with a private part.
      await app.host.call("ssh.keys.delete", { id: key.id });
      if (current === generation.current) {
        setSelectedId(null);
        toast(t("keys.deleteDone"));
      }
    });
  const copy = (text: string) =>
    void run(async (current) => {
      await app.clipboard.writeText(text);
      if (current === generation.current) toast(t("keys.copied"));
    });
  const openEditor = (value: Editor) => {
    setEditor(value);
    setInvalid(null);
    setError(null);
  };
  const editField = (patch: Partial<Editor>) => {
    if (editor) setEditor({ ...editor, ...patch });
    setInvalid(null);
  };
  return (
    <Shell
      toolbar={() => (
        <Toolbar>
          <ToolbarTitle>{t("app.name")}</ToolbarTitle>
          <Spacer />
          <Button
            disabled={list.loading || busy || !allowed}
            onClick={() => setRevision((value) => value + 1)}
          >
            {t("keys.refresh")}
          </Button>
          <Button
            disabled={!allowed || busy || keys.length >= 100}
            onClick={() => openEditor(emptyEditor("import"))}
          >
            {t("keys.import")}
          </Button>
          <Button
            variant="primary"
            disabled={!allowed || busy || keys.length >= 100}
            onClick={() => openEditor(emptyEditor("generate"))}
          >
            {t("keys.generate")}
          </Button>
        </Toolbar>
      )}
    >
      <div className="keys-main">
        <p className="keys-hint">{t("keys.scope")}</p>
        <p className="keys-hint">{t("keys.refreshHint")}</p>
        {allowed && list.data ? (
          <p className="keys-hint">
            {t("keys.loaded", { at: i18n.date(list.data.at, { timeStyle: "medium" }) })}
          </p>
        ) : null}
        {!allowed ? <p role="status">{t("keys.permission")}</p> : null}
        {list.loading ? <LoadingState /> : null}
        {list.error ? (
          <p role="alert">
            {problem(list.error)} {keys.length ? t("keys.stale") : ""}
          </p>
        ) : null}
        {error && !editor && !privateId ? <p role="alert">{problem(error)}</p> : null}
        <div className="keys-filters">
          <SearchInput label={t("keys.search")} value={search} onChange={setSearch} />
          <Select
            label={t("keys.filter")}
            value={filter}
            options={[
              { value: "all", label: t("keys.all") },
              { value: "private", label: t("keys.withPrivate") },
              { value: "public", label: t("keys.publicOnly") },
            ]}
            onChange={setFilter}
          />
          <span>{t("keys.count", { count: keys.length })}</span>
        </div>
        {rows.length ? (
          <div className="keys-table">
            <DataTable
              rows={rows}
              getKey={(key) => key.id}
              label={t("keys.table")}
              selectedKey={selected?.id ?? null}
              onSelect={(key) => setSelectedId(key.id)}
              columns={[
                {
                  key: "name",
                  label: t("keys.name"),
                  sortValue: (key) => key.name,
                  render: (key) => key.name,
                },
                {
                  key: "type",
                  label: t("keys.type"),
                  sortValue: (key) => key.type,
                  render: (key) => key.type,
                },
                {
                  key: "bits",
                  label: t("keys.bits"),
                  sortValue: (key) => key.bits,
                  render: (key) => i18n.number(key.bits),
                },
                {
                  key: "private",
                  label: t("keys.material"),
                  render: (key) => (
                    <Badge>{t(key.hasPrivateKey ? "keys.withPrivate" : "keys.publicOnly")}</Badge>
                  ),
                },
              ]}
            />
          </div>
        ) : !list.loading && allowed ? (
          <EmptyState title={t("keys.empty")} text={t("keys.emptyHint")} />
        ) : null}
        {selected ? (
          <section className="keys-detail">
            <h2>{selected.name}</h2>
            <p>
              {selected.type} · {i18n.number(selected.bits)} {t("keys.bits")}
            </p>
            <p className="keys-fingerprint">{selected.fingerprint}</p>
            <p>
              {t("keys.created", {
                at: i18n.date(selected.createdAt, { dateStyle: "medium", timeStyle: "short" }),
              })}
            </p>
            <p>
              {t("keys.updated", {
                at: i18n.date(selected.updatedAt, { dateStyle: "medium", timeStyle: "short" }),
              })}
            </p>
            {selected.comment ? <p>{selected.comment}</p> : null}
            <TextArea
              label={t("keys.publicKey")}
              value={selected.publicKey}
              readOnly
              rows={3}
              mono
            />
            <div className="keys-actions">
              <Button
                disabled={busy || !grants.has("clipboard:write")}
                onClick={() => copy(selected.publicKey)}
              >
                {t("keys.copyPublic")}
              </Button>
              <Button
                disabled={busy || !grants.has("clipboard:write")}
                onClick={() => copy(selected.fingerprint)}
              >
                {t("keys.copyFingerprint")}
              </Button>
              <Button
                disabled={busy || !grants.has("files:save")}
                onClick={() => exportKey(selected, null)}
              >
                {t("keys.exportPublic")}
              </Button>
              {selected.hasPrivateKey ? (
                <Button
                  disabled={busy || !grants.has("files:save")}
                  onClick={() => {
                    clearSecret();
                    setPrivateId(selected.id);
                    setInvalid(null);
                    setError(null);
                  }}
                >
                  {t("keys.exportPrivate")}
                </Button>
              ) : null}
              <Button
                disabled={busy}
                onClick={() =>
                  openEditor({
                    ...emptyEditor("edit"),
                    id: selected.id,
                    name: selected.name,
                    comment: selected.comment,
                  })
                }
              >
                {t("keys.edit")}
              </Button>
              <Button disabled={busy} onClick={() => remove(selected)}>
                {t("keys.delete")}
              </Button>
            </div>
          </section>
        ) : null}
      </div>
      <Dialog
        open={!!editor}
        title={t(`keys.${editor?.kind ?? "generate"}`)}
        onClose={() => {
          if (!busy) setEditor(null);
        }}
        actions={
          <>
            <Button disabled={busy} onClick={() => setEditor(null)}>
              {t("keys.cancel")}
            </Button>
            <Button variant="primary" disabled={busy || !allowed} onClick={saveEditor}>
              {t("keys.save")}
            </Button>
          </>
        }
      >
        {editor ? (
          <div className="keys-form">
            <TextField
              label={t("keys.name")}
              value={editor.name}
              maxLength={80}
              disabled={busy}
              onChange={(event) => editField({ name: event.target.value })}
            />
            {editor.kind === "generate" ? (
              <Select
                label={t("keys.algorithm")}
                value={editor.type}
                options={SSH_KEY_TYPES.map((type) => ({ value: type, label: type }))}
                disabled={busy}
                onChange={(type) => editField({ type })}
              />
            ) : null}
            {editor.kind !== "import" ? (
              <TextField
                label={t("keys.comment")}
                value={editor.comment}
                maxLength={200}
                disabled={busy}
                onChange={(event) => editField({ comment: event.target.value })}
              />
            ) : (
              <>
                <p className="keys-hint">{t("keys.importHint")}</p>
                <TextArea
                  label={t("keys.publicKey")}
                  value={editor.publicKey}
                  rows={5}
                  maxLength={16384}
                  disabled={busy}
                  onChange={(event) => {
                    if (isPrivateInput(event.target.value)) {
                      editField({ publicKey: "" });
                      setInvalid("publicKey");
                    } else editField({ publicKey: event.target.value });
                  }}
                />
              </>
            )}
            {invalid ? <p role="alert">{t(`validation.${invalid}`)}</p> : null}
            {error ? <p role="alert">{problem(error)}</p> : null}
          </div>
        ) : null}
      </Dialog>
      <Dialog
        open={!!privateKey}
        title={t("keys.exportPrivate")}
        onClose={clearSecret}
        actions={
          <>
            <Button onClick={clearSecret}>{t("keys.cancel")}</Button>
            <Button
              variant="primary"
              disabled={busy || !allowed || !grants.has("files:save")}
              onClick={submitPrivate}
            >
              {t("keys.continue")}
            </Button>
          </>
        }
      >
        <p>{t("keys.privateHint")}</p>
        <p className="keys-fingerprint">{privateKey?.fingerprint}</p>
        <TextField
          label={t("keys.passphrase")}
          type="password"
          autoComplete="new-password"
          value={passphrase}
          maxLength={1023}
          onChange={(event) => {
            setPassphrase(event.target.value);
            setInvalid(null);
          }}
        />
        <TextField
          label={t("keys.repeat")}
          type="password"
          autoComplete="new-password"
          value={repeated}
          maxLength={1023}
          onChange={(event) => {
            setRepeated(event.target.value);
            setInvalid(null);
          }}
        />
        {invalid ? <p role="alert">{t(`validation.${invalid}`)}</p> : null}
      </Dialog>
    </Shell>
  );
}
