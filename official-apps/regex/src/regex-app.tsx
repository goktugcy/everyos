import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  IconButton,
  ListItem,
  Spacer,
  Tabs,
  TextField,
  Toolbar,
  ToolbarTitle,
  errorMessage,
  startWorker,
  useApp,
  useDebounced,
  useI18n,
  useNarrow,
  usePersistentState,
  useT,
  useToast,
} from "@everyos/app-ui";
import { BookOpen, Copy, Save, Trash2 } from "lucide-react";
import { Fragment, useEffect, useMemo, useState } from "react";
import { EXAMPLES, supportedFlags } from "./examples.ts";
import { explain } from "./explain.ts";
import { LIMITS, type MatchInfo } from "./match-core.ts";
import { createMatcher, type Outcome, type WorkerLike } from "./matcher.ts";

interface Expression {
  pattern: string;
  flags: string;
  text: string;
  replacement: string;
}

interface Saved extends Expression {
  id: string;
  name: string;
}

type Panel = "matches" | "explain" | "replace";

const DEFAULT: Expression = {
  pattern: String.raw`(?<word>\w+)@(\w+)\.com`,
  flags: "g",
  text: "ada@example.com, grace@navy.com",
  replacement: "$<word> at $2",
};

/** Highlights stop after this many characters of text (the match list still has everything). */
const HIGHLIGHT_LIMIT = 200_000;

const startMatchWorker = () => startWorker("match.worker.js") as Promise<WorkerLike>;

export function RegexApp({ start = startMatchWorker }: { start?: () => Promise<WorkerLike> }) {
  const app = useApp();
  const t = useT();
  const i18n = useI18n();
  const toast = useToast();
  const narrow = useNarrow(820);
  const [expression, setExpression] = usePersistentState<Expression>("current", DEFAULT);
  const [saved, setSaved] = usePersistentState<Saved[]>("saved", []);
  const [panel, setPanel] = usePersistentState<Panel>("panel", "matches");
  const [examplesOpen, setExamplesOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [running, setRunning] = useState(false);
  const flags = useMemo(supportedFlags, []);
  const matcher = useMemo(() => createMatcher(start), [start]);
  useEffect(() => () => matcher.dispose(), [matcher]);

  const request = useDebounced(expression, 200);
  useEffect(() => {
    if (!request.pattern) {
      setOutcome(null);
      return;
    }
    let stale = false;
    setRunning(true);
    void matcher
      .run({
        pattern: request.pattern,
        flags: request.flags,
        text: request.text,
        replacement: panel === "replace" ? request.replacement : null,
      })
      .then((result) => {
        if (stale) return;
        setOutcome(result);
        setRunning(false);
      });
    return () => {
      stale = true;
    };
  }, [matcher, request, panel]);

  const update = (patch: Partial<Expression>) =>
    setExpression((current) => ({ ...current, ...patch }));
  const toggleFlag = (flag: string) => {
    const has = expression.flags.includes(flag);
    let next = has ? expression.flags.replace(flag, "") : expression.flags + flag;
    // u and v cannot be combined.
    if (!has && flag === "u") next = next.replace("v", "");
    if (!has && flag === "v") next = next.replace("u", "");
    update({ flags: flags.filter((entry) => next.includes(entry)).join("") });
  };
  const copy = async (text: string) => {
    try {
      await app.clipboard.writeText(text);
      toast(t("ui.copied"));
    } catch (caught) {
      toast(errorMessage(t, caught), "danger");
    }
  };

  const parts = useMemo(() => explain(expression.pattern), [expression.pattern]);
  const matches = outcome?.ok ? outcome.matches : [];
  const status = !expression.pattern
    ? t("status.empty")
    : running && !outcome
      ? t("status.running")
      : !outcome
        ? ""
        : outcome.ok
          ? `${t("status.matches", { count: outcome.matches.length })} · ${t("status.ms", { ms: i18n.number(outcome.ms) })}`
          : outcome.error === "timeout"
            ? t("status.timeout", { seconds: LIMITS.timeoutMs / 1000 })
            : outcome.error === "too-long"
              ? t("status.tooLong", { count: i18n.number(LIMITS.text) })
              : outcome.error === "syntax"
                ? t("status.syntax", { message: outcome.message })
                : t("status.worker", { message: outcome.message });

  const highlighted = useMemo(() => {
    const text = expression.text.slice(0, HIGHLIGHT_LIMIT);
    const pieces: React.ReactNode[] = [];
    let at = 0;
    matches.forEach((match, index) => {
      if (match.index >= text.length) return;
      if (match.index > at)
        pieces.push(<Fragment key={`t${index}`}>{text.slice(at, match.index)}</Fragment>);
      const end = Math.min(match.end, text.length);
      pieces.push(
        <mark
          key={`m${index}`}
          data-alternate={index % 2 || undefined}
          data-empty={match.end === match.index || undefined}
        >
          {text.slice(Math.max(at, match.index), end)}
        </mark>,
      );
      at = Math.max(at, end);
    });
    if (at < text.length) pieces.push(<Fragment key="rest">{text.slice(at)}</Fragment>);
    return pieces;
  }, [expression.text, matches]);

  return (
    <div className="rx-app">
      <Toolbar label={t("app.name")}>
        <ToolbarTitle>{t("app.name")}</ToolbarTitle>
        <Spacer />
        <Button
          size="sm"
          variant="ghost"
          icon={<BookOpen size={15} aria-hidden />}
          onClick={() => setExamplesOpen(true)}
        >
          {t("examples.title")}
        </Button>
        <Button
          size="sm"
          icon={<Save size={15} aria-hidden />}
          onClick={() => {
            setSaveName("");
            setSaveOpen(true);
          }}
        >
          {t("saved.save")}
        </Button>
      </Toolbar>
      <div className="rx-body" data-narrow={narrow || undefined}>
        <section className="rx-input" aria-label={t("pattern.section")}>
          <div className="rx-pattern">
            <span aria-hidden>/</span>
            <input
              className="eui-input eui-mono"
              aria-label={t("pattern.label")}
              placeholder={t("pattern.placeholder")}
              value={expression.pattern}
              spellCheck={false}
              aria-invalid={outcome && !outcome.ok && outcome.error === "syntax" ? true : undefined}
              onChange={(event) => update({ pattern: event.target.value })}
            />
            <span aria-hidden>/{expression.flags}</span>
            <IconButton
              size="sm"
              label={t("pattern.copy")}
              icon={<Copy size={14} aria-hidden />}
              onClick={() => void copy(`/${expression.pattern}/${expression.flags}`)}
            />
          </div>
          <div className="rx-flags" role="group" aria-label={t("flags.label")}>
            {flags.map((flag) => (
              <button
                key={flag}
                type="button"
                className="rx-flag"
                aria-pressed={expression.flags.includes(flag)}
                title={t(`flags.${flag}`)}
                onClick={() => toggleFlag(flag)}
              >
                <code>{flag}</code> {t(`flags.short.${flag}`)}
              </button>
            ))}
          </div>
          <p
            className="rx-status"
            role="status"
            data-error={outcome && !outcome.ok ? true : undefined}
          >
            {status}
          </p>
          <label className="eui-field rx-text">
            <span className="eui-label">{t("text.label")}</span>
            <textarea
              className="eui-textarea eui-mono"
              value={expression.text}
              spellCheck={false}
              onChange={(event) => update({ text: event.target.value })}
            />
          </label>
          <div className="rx-highlight eui-mono" aria-label={t("text.highlighted")}>
            {highlighted}
            {expression.text.length > HIGHLIGHT_LIMIT ? (
              <p className="eui-hint">{t("text.highlightLimit")}</p>
            ) : null}
          </div>
        </section>
        <section className="rx-panel" aria-label={t(`panels.${panel}`)}>
          <Tabs<Panel>
            label={t("panels.label")}
            value={panel}
            onChange={setPanel}
            tabs={(["matches", "explain", "replace"] as const).map((value) => ({
              value,
              label: t(`panels.${value}`),
            }))}
          />
          <div className="rx-panel-body">
            {panel === "matches" ? (
              <MatchList matches={matches} truncated={outcome?.ok ? outcome.truncated : false} />
            ) : panel === "explain" ? (
              parts.length ? (
                <ol className="rx-explain">
                  {parts.map((part, index) => (
                    <li
                      key={`${part.start}-${index}`}
                      style={{ paddingInlineStart: 8 + part.depth * 16 }}
                    >
                      <code>{expression.pattern.slice(part.start, part.end)}</code>
                      <span>{t(`explain.${part.key}`, part.values)}</span>
                    </li>
                  ))}
                </ol>
              ) : (
                <EmptyState title={t("status.empty")} />
              )
            ) : (
              <div className="rx-replace">
                <TextField
                  label={t("replace.label")}
                  mono
                  hint={t("replace.hint")}
                  value={expression.replacement}
                  onChange={(event) => update({ replacement: event.target.value })}
                />
                <div className="rx-replace-head">
                  <span className="eui-label">{t("replace.result")}</span>
                  <IconButton
                    size="sm"
                    label={t("replace.copy")}
                    icon={<Copy size={14} aria-hidden />}
                    disabled={!outcome?.ok || outcome.replaced === null}
                    onClick={() =>
                      outcome?.ok && outcome.replaced !== null && void copy(outcome.replaced)
                    }
                  />
                </div>
                <pre className="rx-replaced">{outcome?.ok ? (outcome.replaced ?? "") : ""}</pre>
              </div>
            )}
          </div>
          {saved.length ? (
            <div className="rx-saved">
              <h2>{t("saved.title")}</h2>
              <ul className="eui-list">
                {saved.map((entry) => (
                  <li key={entry.id} className="rx-saved-item">
                    <ListItem
                      title={entry.name}
                      meta={`/${entry.pattern}/${entry.flags}`}
                      onClick={() =>
                        setExpression({
                          pattern: entry.pattern,
                          flags: entry.flags,
                          text: entry.text,
                          replacement: entry.replacement,
                        })
                      }
                    />
                    <IconButton
                      size="sm"
                      label={t("saved.delete", { name: entry.name })}
                      icon={<Trash2 size={14} aria-hidden />}
                      onClick={() =>
                        setSaved((list) => list.filter((item) => item.id !== entry.id))
                      }
                    />
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      </div>
      <Dialog
        open={examplesOpen}
        title={t("examples.title")}
        onClose={() => setExamplesOpen(false)}
        actions={<Button onClick={() => setExamplesOpen(false)}>{t("ui.close")}</Button>}
      >
        <ul className="eui-list rx-examples">
          {EXAMPLES.map((example) => (
            <li key={example.id}>
              <ListItem
                title={t(`examples.${example.id}.name`)}
                meta={t(`examples.${example.id}.description`)}
                onClick={() => {
                  setExpression({
                    pattern: example.pattern,
                    flags: flags.filter((flag) => example.flags.includes(flag)).join(""),
                    text: example.text,
                    replacement: expression.replacement,
                  });
                  setExamplesOpen(false);
                }}
              />
            </li>
          ))}
        </ul>
      </Dialog>
      <Dialog
        open={saveOpen}
        title={t("saved.save")}
        onClose={() => setSaveOpen(false)}
        actions={
          <>
            <Button onClick={() => setSaveOpen(false)}>{t("ui.cancel")}</Button>
            <Button
              variant="primary"
              disabled={!saveName.trim()}
              onClick={() => {
                setSaved((list) =>
                  [
                    ...list.filter((entry) => entry.name !== saveName.trim()),
                    { ...expression, id: `${Date.now()}`, name: saveName.trim().slice(0, 80) },
                  ].slice(-100),
                );
                setSaveOpen(false);
                toast(t("saved.done"));
              }}
            >
              {t("ui.save")}
            </Button>
          </>
        }
      >
        <TextField
          label={t("saved.name")}
          value={saveName}
          maxLength={80}
          autoFocus
          onChange={(event) => setSaveName(event.target.value)}
        />
      </Dialog>
    </div>
  );
}

function MatchList({ matches, truncated }: { matches: readonly MatchInfo[]; truncated: boolean }) {
  const t = useT();
  if (!matches.length) return <EmptyState title={t("matches.none")} />;
  return (
    <div className="rx-matches">
      {truncated ? (
        <p className="eui-hint">{t("matches.truncated", { count: LIMITS.matches })}</p>
      ) : null}
      <ol>
        {matches.slice(0, 1000).map((match, index) => (
          <li key={`${match.index}-${index}`}>
            <div className="rx-match-head">
              <Badge tone="accent">{index + 1}</Badge>
              <code className="rx-match-text">
                {match.text === "" ? t("matches.empty") : JSON.stringify(match.text)}
              </code>
              <span className="rx-range">
                {t("matches.range", { start: match.index, end: match.end })}
              </span>
            </div>
            {match.groups.length ? (
              <table className="rx-groups">
                <tbody>
                  {match.groups.map((group) => (
                    <tr key={group.number}>
                      <th scope="row">
                        {group.name ? `${group.number} · ${group.name}` : group.number}
                      </th>
                      <td>
                        <code>
                          {group.value === null
                            ? t("matches.unmatched")
                            : JSON.stringify(group.value)}
                        </code>
                      </td>
                      <td className="rx-range">
                        {group.start !== null ? `${group.start}–${group.end}` : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </li>
        ))}
      </ol>
      {matches.length > 1000 ? (
        <p className="eui-hint">{t("matches.more", { count: matches.length - 1000 })}</p>
      ) : null}
    </div>
  );
}
