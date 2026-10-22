import { BridgeError, DNS_RECORD_TYPES, type DnsRecordType } from "@everyos/app-sdk";
import {
  Button,
  EmptyState,
  errorMessage,
  ErrorState,
  ListItem,
  LoadingState,
  networkMessage,
  Select,
  Shell,
  Spacer,
  TextField,
  Toolbar,
  ToolbarTitle,
  useApp,
  useI18n,
  usePersistentState,
  useT,
  useToast,
} from "@everyos/app-ui";
import { Copy, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  addHistory,
  COMMON_TYPES,
  DEFAULT_SETTINGS,
  isIp,
  normalizeName,
  PUBLIC_SERVERS,
  readHistory,
  readSettings,
  zoneLines,
  type HistoryEntry,
  type Settings,
} from "./dns.ts";
import { Results, type Answer } from "./results.tsx";

export function DnsApp() {
  const app = useApp();
  const t = useT();
  const i18n = useI18n();
  const toast = useToast();
  const [rawSettings, saveSettings, settingsState] = usePersistentState<unknown>(
    "settings",
    DEFAULT_SETTINGS,
  );
  const [rawHistory, saveHistory, historyState] = usePersistentState<unknown>("history", []);
  const settings = readSettings(rawSettings);
  const history = readHistory(rawHistory);
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [queried, setQueried] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [allowed, setAllowed] = useState(() => app.permissions.has("network:outbound"));
  const generation = useRef(0);
  const active = useRef(false);

  useEffect(() => {
    const stop = app.permissions.onChange((granted) => {
      setAllowed(granted.has("network:outbound"));
      generation.current++;
      active.current = false;
      setBusy(false);
    });
    return () => {
      stop();
      generation.current++;
    };
  }, [app]);
  const update = (next: Partial<Settings>) => {
    saveSettings({ ...settings, ...next });
    setProblem(null);
  };
  const fail = (error: unknown) => toast(errorMessage(t, error), "danger");
  const copy = async (text: string) => {
    try {
      await app.clipboard.writeText(text);
      toast(t("ui.copied"));
    } catch (error) {
      fail(error);
    }
  };
  const run = async (saved?: HistoryEntry) => {
    if (active.current || !settingsState.loaded || !historyState.loaded) return;
    const types: DnsRecordType[] =
      saved?.types ?? (settings.type === "common" ? [...COMMON_TYPES] : [settings.type]);
    const normalized = normalizeName(saved?.name ?? settings.name, types[0]!);
    if ("problem" in normalized) {
      setProblem(`validation.${normalized.problem}`);
      return;
    }
    const server = saved
      ? saved.server
      : settings.server === "system"
        ? null
        : settings.server === "custom"
          ? settings.custom.trim()
          : (PUBLIC_SERVERS.find((s) => s.id === settings.server)?.address ?? null);
    const port = saved?.port ?? (settings.server === "custom" ? Number(settings.port) : 53);
    if (server !== null && !isIp(server)) {
      setProblem("validation.server");
      return;
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setProblem("validation.port");
      return;
    }
    if (saved)
      saveSettings({
        name: saved.name,
        type: saved.types.length === 1 ? saved.types[0]! : "common",
        server: saved.server ? "custom" : "system",
        custom: saved.server ?? "",
        port: String(saved.port),
      });
    const current = ++generation.current;
    active.current = true;
    setBusy(true);
    setAnswers([]);
    setProblem(null);
    setQueried(normalized.name);
    const next: Answer[] = [];
    try {
      // Serial queries respect the person's shared four-operation network budget.
      for (const type of types) {
        if (current !== generation.current) return;
        try {
          const result = await app.host.call("net.dns", {
            name: normalized.name,
            type,
            server,
            serverPort: port,
            timeoutMs: 8000,
          });
          next.push({ type, result });
        } catch (error) {
          next.push({ type, error });
        }
        if (current !== generation.current) return;
        setAnswers([...next]);
      }
      if (next.some((answer) => answer.result))
        saveHistory((stored: unknown) =>
          addHistory(readHistory(stored), {
            name: normalized.name,
            types,
            server,
            port,
            at: Date.now(),
          }),
        );
    } finally {
      if (current === generation.current) {
        active.current = false;
        setBusy(false);
      }
    }
  };
  const clearHistory = async () => {
    try {
      if (await app.dialogs.confirm(t("history.clear"), t("ui.deleteBody"), { destructive: true }))
        saveHistory([]);
    } catch (error) {
      fail(error);
    }
  };
  const storageError = settingsState.error ?? historyState.error;
  if (!settingsState.loaded || !historyState.loaded) return <LoadingState />;
  return (
    <Shell
      toolbar={() => (
        <Toolbar>
          <ToolbarTitle>{t("app.name")}</ToolbarTitle>
          <Spacer />
          {answers.some((a) => a.result?.records.length) ? (
            <Button
              icon={<Copy size={16} aria-hidden />}
              onClick={() =>
                void copy(answers.flatMap((a) => (a.result ? zoneLines(a.result) : [])).join("\n"))
              }
            >
              {t("results.copyAll")}
            </Button>
          ) : null}
        </Toolbar>
      )}
    >
      {storageError ? <ErrorState error={storageError} /> : null}
      <div className="dns-layout">
        <div className="dns-main">
          <form
            className="dns-form"
            onSubmit={(event) => {
              event.preventDefault();
              void run();
            }}
          >
            <TextField
              label={t("query.name")}
              value={settings.name}
              maxLength={1024}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              mono
              onChange={(e) => update({ name: e.target.value })}
            />
            <Select
              label={t("query.type")}
              value={settings.type}
              options={[
                { value: "common", label: t("query.common") },
                ...DNS_RECORD_TYPES.map((value) => ({ value, label: value })),
              ]}
              onChange={(type) => update({ type })}
            />
            <Select
              label={t("query.server")}
              value={settings.server}
              options={[
                { value: "system", label: t("query.system") },
                ...PUBLIC_SERVERS.map((s) => ({ value: s.id, label: t(`query.${s.id}`) })),
                { value: "custom", label: t("query.custom") },
              ]}
              onChange={(server) => update({ server })}
            />
            {settings.server === "custom" ? (
              <>
                <TextField
                  label={t("query.address")}
                  value={settings.custom}
                  mono
                  onChange={(e) => update({ custom: e.target.value })}
                />
                <TextField
                  label={t("query.port")}
                  type="number"
                  min={1}
                  max={65535}
                  value={settings.port}
                  onChange={(e) => update({ port: e.target.value })}
                />
              </>
            ) : null}
            <Button
              type="submit"
              variant="primary"
              icon={<Search size={16} aria-hidden />}
              disabled={busy || !allowed}
            >
              {busy ? t("query.working") : t("query.run")}
            </Button>
          </form>
          <p className="dns-meta">
            {t(settings.server === "system" ? "query.systemHint" : "query.policyHint")}
          </p>
          {!allowed ? (
            <p role="alert" className="eui-error-text">
              {networkMessage(t, new BridgeError("FORBIDDEN", ""))}
            </p>
          ) : null}
          {problem ? (
            <p role="alert" className="eui-error-text">
              {t(problem)}
            </p>
          ) : null}
          {busy ? (
            <div role="status" aria-live="polite">
              {t("query.working")}
            </div>
          ) : null}
          {queried ? <h1 className="dns-name">{queried}</h1> : null}
          {answers.length ? (
            <Results answers={answers} copy={(text) => void copy(text)} />
          ) : !busy ? (
            <EmptyState title={t("results.empty")} text={t("results.emptyHint")} />
          ) : null}
        </div>
        <aside className="dns-history" aria-label={t("history.title")}>
          <Toolbar>
            <ToolbarTitle>{t("history.title")}</ToolbarTitle>
            <Spacer />
            {history.length ? (
              <Button size="sm" variant="ghost" onClick={() => void clearHistory()}>
                {t("ui.clear")}
              </Button>
            ) : null}
          </Toolbar>
          {!history.length ? (
            <p className="dns-meta">{t("history.empty")}</p>
          ) : (
            history.map((entry) => (
              <ListItem
                key={`${entry.name}/${entry.server}/${entry.port}/${entry.types.join()}`}
                title={entry.name}
                meta={`${entry.types.join(", ")} · ${entry.server ?? t("query.system")} · ${i18n.date(entry.at, { dateStyle: "short", timeStyle: "short" })}`}
                onClick={() => void run(entry)}
              />
            ))
          )}
        </aside>
      </div>
    </Shell>
  );
}
