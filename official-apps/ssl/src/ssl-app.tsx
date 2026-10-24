import { BridgeError, type NetTlsResult } from "@everyos/app-sdk";
import {
  Button,
  EmptyState,
  errorMessage,
  ErrorState,
  IconButton,
  ListItem,
  LoadingState,
  networkMessage,
  Shell,
  Spacer,
  TextField,
  Toolbar,
  ToolbarTitle,
  useApp,
  usePersistentState,
  useT,
  useToast,
} from "@everyos/app-ui";
import { ShieldCheck, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Certificates } from "./certificates.tsx";
import {
  EMPTY_DRAFT,
  endpointDraft,
  endpointKey,
  endpointLabel,
  MAX_ENDPOINTS,
  parseEndpoint,
  readDraft,
  readEndpoints,
  tlsInput,
  type Draft,
  type Endpoint,
} from "./tls.ts";

export function SslApp() {
  const app = useApp();
  const t = useT();
  const toast = useToast();
  const [storedDraft, saveDraft, draftState] = usePersistentState<unknown>("draft", EMPTY_DRAFT);
  const [storedEndpoints, saveEndpoints, endpointsState] = usePersistentState<unknown>(
    "endpoints",
    [],
  );
  const draft = readDraft(storedDraft);
  const endpoints = readEndpoints(storedEndpoints);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<NetTlsResult | null>(null);
  const [inspected, setInspected] = useState<Endpoint | null>(null);
  const [allowed, setAllowed] = useState(() => app.permissions.has("network:outbound"));
  const [now, setNow] = useState(Date.now);
  const generation = useRef(0);
  const active = useRef(false);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60000);
    const stop = app.permissions.onChange((granted) => {
      setAllowed(granted.has("network:outbound"));
      generation.current++;
      active.current = false;
      setBusy(false);
    });
    return () => {
      clearInterval(timer);
      stop();
      generation.current++;
    };
  }, [app]);
  const update = (change: Partial<Draft>) => {
    saveDraft({ ...draft, ...change });
    setError(null);
  };
  const inspect = async (saved?: Endpoint) => {
    if (active.current || !allowed) return;
    const target = saved ?? parseEndpoint(draft);
    if (!target) {
      setError("target.invalid");
      return;
    }
    if (saved) saveDraft(endpointDraft(saved));
    const current = ++generation.current;
    active.current = true;
    setBusy(true);
    setError(null);
    setResult(null);
    setInspected(target);
    try {
      const response = await app.host.call("net.tls", tlsInput(target));
      if (current === generation.current) {
        setResult(response);
        setNow(Date.now());
      }
    } catch (caught) {
      if (current === generation.current) setError(caught);
    } finally {
      if (current === generation.current) {
        active.current = false;
        setBusy(false);
      }
    }
  };
  const save = () => {
    const target = parseEndpoint(draft);
    if (!target) {
      setError("target.invalid");
      return;
    }
    if (endpoints.some((saved) => endpointKey(saved) === endpointKey(target))) {
      toast(t("ui.saved"));
      return;
    }
    if (endpoints.length >= MAX_ENDPOINTS) {
      setError("saved.limit");
      return;
    }
    saveEndpoints([target, ...endpoints]);
    toast(t("ui.saved"));
  };
  const remove = async (target: Endpoint) => {
    const label = endpointLabel(target);
    try {
      if (
        await app.dialogs.confirm(t("ui.confirmDelete", { name: label }), t("ui.deleteBody"), {
          destructive: true,
        })
      )
        saveEndpoints(endpoints.filter((saved) => endpointKey(saved) !== endpointKey(target)));
    } catch (caught) {
      toast(errorMessage(t, caught), "danger");
    }
  };
  if (!draftState.loaded || !endpointsState.loaded) return <LoadingState />;
  return (
    <Shell
      toolbar={() => (
        <Toolbar>
          <ToolbarTitle>{t("app.name")}</ToolbarTitle>
          <Spacer />
          <Button onClick={save}>{t("saved.save")}</Button>
        </Toolbar>
      )}
    >
      {draftState.error || endpointsState.error ? (
        <ErrorState error={draftState.error ?? endpointsState.error} />
      ) : null}
      <div className="ssl-layout">
        <div className="ssl-main">
          <form
            className="ssl-form"
            onSubmit={(event) => {
              event.preventDefault();
              void inspect();
            }}
          >
            <TextField
              label={t("target.host")}
              value={draft.host}
              maxLength={1024}
              autoCapitalize="none"
              spellCheck={false}
              mono
              onChange={(event) => update({ host: event.target.value })}
            />
            <TextField
              label={t("target.port")}
              type="number"
              min={1}
              max={65535}
              value={draft.port}
              onChange={(event) => update({ port: event.target.value })}
            />
            <TextField
              label={t("target.sni")}
              value={draft.servername}
              maxLength={1024}
              autoCapitalize="none"
              spellCheck={false}
              mono
              onChange={(event) => update({ servername: event.target.value })}
            />
            <Button
              type="submit"
              variant="primary"
              icon={<ShieldCheck size={16} aria-hidden />}
              disabled={busy || !allowed}
            >
              {t(busy ? "target.working" : "target.inspect")}
            </Button>
          </form>
          <p className="ssl-hint">{t("target.hint")}</p>
          {!allowed ? (
            <p role="alert" className="eui-error-text">
              {networkMessage(t, new BridgeError("FORBIDDEN", ""))}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="eui-error-text">
              {error === "target.invalid" || error === "saved.limit"
                ? t(error)
                : networkMessage(t, error)}
            </p>
          ) : null}
          {busy ? <LoadingState text={t("target.working")} /> : null}
          {inspected ? (
            <h2>
              {endpointLabel(inspected)}
              {inspected.servername ? <small>{inspected.servername}</small> : null}
            </h2>
          ) : null}
          {result ? (
            <Certificates result={result} now={now} />
          ) : !busy && !error ? (
            <EmptyState title={t("result.empty")} />
          ) : null}
        </div>
        <aside className="ssl-saved" aria-label={t("saved.title")}>
          <h2>{t("saved.title")}</h2>
          {endpoints.length ? (
            endpoints.map((target) => (
              <div key={endpointKey(target)} className="ssl-endpoint">
                <ListItem
                  title={endpointLabel(target)}
                  meta={target.servername ?? undefined}
                  onClick={() => void inspect(target)}
                />
                <IconButton
                  label={t("saved.remove", { target: endpointLabel(target) })}
                  icon={<Trash2 size={16} aria-hidden />}
                  onClick={() => void remove(target)}
                />
              </div>
            ))
          ) : (
            <p className="ssl-hint">{t("saved.empty")}</p>
          )}
        </aside>
      </div>
    </Shell>
  );
}
