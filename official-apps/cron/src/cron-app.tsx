import {
  Badge,
  Button,
  IconButton,
  ListItem,
  Select,
  Spacer,
  Switch,
  TextField,
  Toolbar,
  ToolbarTitle,
  errorMessage,
  saveTextFile,
  useApp,
  useI18n,
  useNarrow,
  usePersistentState,
  useT,
  useToast,
} from "@everyos/app-ui";
import { Copy, FileDown, Save, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import {
  CronError,
  FIELD_LIMITS,
  fieldMode,
  fieldText,
  forEveryOSTask,
  parseCron,
  PRESETS,
  toOnCalendar,
  type FieldMode,
  type FieldName,
  type ParsedCron,
} from "./cron.ts";
import { describe, localTimeZone, runs, timeZones } from "./runs.ts";

interface State {
  expression: string;
  seconds: boolean;
  timeZone: string;
  command: string;
}

interface Saved {
  id: string;
  name: string;
  expression: string;
}

const FIVE: FieldName[] = ["minute", "hour", "day", "month", "weekday"];
const SIX: FieldName[] = ["second", ...FIVE];

export function CronApp() {
  const app = useApp();
  const t = useT();
  const i18n = useI18n();
  const toast = useToast();
  const narrow = useNarrow(860);
  const [state, setState] = usePersistentState<State>("state", {
    expression: "0 9 * * 1-5",
    seconds: false,
    timeZone: localTimeZone(),
    command: "",
  });
  const [saved, setSaved] = usePersistentState<Saved[]>("saved", []);
  const [name, setName] = useState("");
  const zones = useMemo(timeZones, []);

  const result = useMemo((): { parsed: ParsedCron } | { error: CronError } => {
    try {
      return { parsed: parseCron(state.expression, state.seconds) };
    } catch (error) {
      if (error instanceof CronError) return { error };
      throw error;
    }
  }, [state.expression, state.seconds]);
  const parsed = "parsed" in result ? result.parsed : null;

  const description = useMemo(() => {
    if (!parsed) return null;
    try {
      return describe(parsed.normalized, i18n.locale);
    } catch {
      return null;
    }
  }, [parsed, i18n.locale]);

  const schedule = useMemo(() => {
    if (!parsed) return null;
    const now = new Date();
    return {
      next: runs(parsed.normalized, state.timeZone, now, 10, "next"),
      previous: runs(parsed.normalized, state.timeZone, now, 5, "prev"),
    };
  }, [parsed, state.timeZone]);

  const formatRun = (date: Date) =>
    new Intl.DateTimeFormat(i18n.tag, {
      dateStyle: "full",
      timeStyle: state.seconds ? "medium" : "short",
      timeZone: state.timeZone,
    }).format(date);

  const names = state.seconds ? SIX : FIVE;
  const parts = state.expression.trim().split(/\s+/);
  const builderReady = parsed !== null && parts.length === names.length;
  const setField = (index: number, mode: FieldMode) => {
    const next = names.map((field, i) =>
      i === index ? fieldText(mode, field) : (parts[i] ?? "*"),
    );
    setState((current) => ({ ...current, expression: next.join(" ") }));
  };

  const copy = async (text: string) => {
    try {
      await app.clipboard.writeText(text);
      toast(t("ui.copied"));
    } catch (caught) {
      toast(errorMessage(t, caught), "danger");
    }
  };

  const crontabLine = parsed
    ? `${parsed.normalized} ${state.command.trim() || t("export.commandPlaceholder")}`
    : "";
  // systemd reads a time zone at the end of the line, so the timer runs in the zone shown here.
  const onCalendar = parsed ? toOnCalendar(parsed).map((line) => `${line} ${state.timeZone}`) : [];
  const task = parsed ? forEveryOSTask(state.expression) : null;
  const timerFile = parsed
    ? `[Unit]\nDescription=${state.command.trim() || t("export.defaultDescription")}\n\n[Timer]\n${onCalendar.map((line) => `OnCalendar=${line}`).join("\n")}\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n`
    : "";

  return (
    <div className="cron-app">
      <Toolbar label={t("app.name")}>
        <ToolbarTitle>{t("app.name")}</ToolbarTitle>
        <Spacer />
        <label className="cron-switch">
          <Switch
            label={t("seconds.label")}
            checked={state.seconds}
            onChange={(seconds) =>
              setState((current) => ({
                ...current,
                seconds,
                expression: seconds
                  ? `0 ${current.expression.trim()}`
                  : current.expression.trim().split(/\s+/).slice(-5).join(" "),
              }))
            }
          />
          <span aria-hidden>{t("seconds.label")}</span>
        </label>
      </Toolbar>
      <div className="cron-body" data-narrow={narrow || undefined}>
        <section className="cron-main" aria-label={t("expression.section")}>
          <div className="cron-expression">
            <input
              className="eui-input eui-mono"
              aria-label={t("expression.label")}
              value={state.expression}
              spellCheck={false}
              aria-invalid={"error" in result || undefined}
              onChange={(event) =>
                setState((current) => ({ ...current, expression: event.target.value }))
              }
            />
            <IconButton
              label={t("expression.copy")}
              icon={<Copy size={15} aria-hidden />}
              onClick={() => void copy(state.expression.trim())}
            />
          </div>
          <p className="cron-description" role="status" data-error={"error" in result || undefined}>
            {"error" in result
              ? t(`problems.${result.error.problem}`, {
                  field: result.error.field ? t(`fields.${result.error.field}`) : "",
                  token: result.error.token,
                  count: names.length,
                })
              : (description ?? "")}
          </p>
          {builderReady ? (
            <div className="cron-builder">
              {names.map((field, index) => (
                <FieldEditor
                  key={field}
                  name={field}
                  text={parts[index] ?? "*"}
                  onChange={(mode) => setField(index, mode)}
                />
              ))}
            </div>
          ) : null}
          <section className="cron-presets" aria-label={t("presets.title")}>
            <h2>{t("presets.title")}</h2>
            <div className="cron-chips">
              {PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className="cron-chip"
                  title={preset.expression}
                  onClick={() =>
                    setState((current) => ({
                      ...current,
                      seconds: false,
                      expression: preset.expression,
                    }))
                  }
                >
                  {t(`presets.${preset.id}`)}
                </button>
              ))}
            </div>
          </section>
        </section>
        <section className="cron-side" aria-label={t("runs.section")}>
          <Select<string>
            label={t("runs.timeZone")}
            value={state.timeZone}
            options={zones.map((zone) => ({ value: zone, label: zone.replace(/_/g, " ") }))}
            onChange={(timeZone) => setState((current) => ({ ...current, timeZone }))}
          />
          <h2>{t("runs.next")}</h2>
          {schedule?.next.length ? (
            <ol className="cron-runs">
              {schedule.next.map((date) => (
                <li key={date.getTime()}>{formatRun(date)}</li>
              ))}
            </ol>
          ) : (
            <p className="eui-hint">{parsed ? t("runs.none") : t("runs.invalid")}</p>
          )}
          {schedule?.previous.length ? (
            <details>
              <summary>{t("runs.previous")}</summary>
              <ol className="cron-runs">
                {schedule.previous.map((date) => (
                  <li key={date.getTime()}>{formatRun(date)}</li>
                ))}
              </ol>
            </details>
          ) : null}
          {parsed ? (
            <section className="cron-export" aria-label={t("export.title")}>
              <h2>{t("export.title")}</h2>
              <TextField
                label={t("export.command")}
                placeholder={t("export.commandPlaceholder")}
                mono
                value={state.command}
                onChange={(event) =>
                  setState((current) => ({ ...current, command: event.target.value }))
                }
              />
              <Output label={t("export.crontab")} value={crontabLine} onCopy={copy} />
              <Output
                label={t("export.onCalendar")}
                value={onCalendar.join("\n")}
                onCopy={copy}
                hint={
                  onCalendar.length > 1
                    ? t("export.twoLines")
                    : t("export.timezone", { zone: state.timeZone })
                }
              />
              <div className="cron-task">
                <span className="eui-label">{t("export.everyos")}</span>
                {task && !task.problems.length ? (
                  <>
                    <Badge tone="success">{t("export.compatible")}</Badge>
                    <code>{task.expression}</code>
                    <IconButton
                      size="sm"
                      label={t("ui.copy")}
                      icon={<Copy size={13} aria-hidden />}
                      onClick={() => void copy(task.expression)}
                    />
                  </>
                ) : (
                  <span className="eui-hint">
                    {task?.problems.map((problem) => t(`export.problems.${problem}`)).join(" ")}
                  </span>
                )}
              </div>
              <Button
                size="sm"
                icon={<FileDown size={14} aria-hidden />}
                onClick={async () => {
                  try {
                    if (await saveTextFile(app, "job.timer", timerFile, { accept: [".timer"] }))
                      toast(t("ui.exported"));
                  } catch (caught) {
                    toast(errorMessage(t, caught), "danger");
                  }
                }}
              >
                {t("export.timerFile")}
              </Button>
              <p className="eui-hint">{t("export.notScheduled")}</p>
            </section>
          ) : null}
          <section className="cron-saved" aria-label={t("saved.title")}>
            <h2>{t("saved.title")}</h2>
            <div className="cron-save-row">
              <input
                className="eui-input"
                aria-label={t("saved.name")}
                placeholder={t("saved.name")}
                value={name}
                maxLength={80}
                onChange={(event) => setName(event.target.value)}
              />
              <IconButton
                label={t("saved.save")}
                icon={<Save size={15} aria-hidden />}
                disabled={!name.trim() || !parsed}
                onClick={() => {
                  setSaved((list) =>
                    [
                      ...list.filter((entry) => entry.name !== name.trim()),
                      {
                        id: `${Date.now()}`,
                        name: name.trim(),
                        expression: state.expression.trim(),
                      },
                    ].slice(-100),
                  );
                  setName("");
                  toast(t("saved.done"));
                }}
              />
            </div>
            <ul className="eui-list">
              {saved.map((entry) => (
                <li key={entry.id} className="cron-saved-item">
                  <ListItem
                    title={entry.name}
                    meta={entry.expression}
                    onClick={() =>
                      setState((current) => ({
                        ...current,
                        expression: entry.expression,
                        seconds: entry.expression.split(/\s+/).length === 6,
                      }))
                    }
                  />
                  <IconButton
                    size="sm"
                    label={t("saved.delete", { name: entry.name })}
                    icon={<Trash2 size={13} aria-hidden />}
                    onClick={() => setSaved((list) => list.filter((item) => item.id !== entry.id))}
                  />
                </li>
              ))}
            </ul>
          </section>
        </section>
      </div>
    </div>
  );
}

function Output({
  label,
  value,
  hint,
  onCopy,
}: {
  label: string;
  value: string;
  hint?: string;
  onCopy: (text: string) => Promise<void>;
}) {
  const t = useT();
  return (
    <div className="cron-output">
      <div className="cron-output-head">
        <span className="eui-label">{label}</span>
        <IconButton
          size="sm"
          label={t("ui.copy")}
          icon={<Copy size={13} aria-hidden />}
          onClick={() => void onCopy(value)}
        />
      </div>
      <pre aria-label={label}>{value}</pre>
      {hint ? <span className="eui-hint">{hint}</span> : null}
    </div>
  );
}

function FieldEditor({
  name,
  text,
  onChange,
}: {
  name: FieldName;
  text: string;
  onChange: (mode: FieldMode) => void;
}) {
  const t = useT();
  const i18n = useI18n();
  const mode = fieldMode(text, name);
  const { min, max } = FIELD_LIMITS[name];
  const top = name === "weekday" ? 6 : max;
  const options = Array.from({ length: top - min + 1 }, (_, index) => min + index);
  const label = (value: number) =>
    name === "weekday"
      ? i18n.date(new Date(2024, 0, 7 + value), { weekday: "short" })
      : name === "month"
        ? i18n.date(new Date(2024, value - 1, 1), { month: "short" })
        : String(value);
  const numberInput = (value: number, set: (value: number) => void, aria: string) => (
    <select
      className="eui-select"
      aria-label={aria}
      value={value}
      onChange={(event) => set(Number(event.target.value))}
    >
      {options.map((option) => (
        <option key={option} value={option}>
          {label(option)}
        </option>
      ))}
    </select>
  );
  return (
    <fieldset className="cron-field">
      <legend>
        {t(`fields.${name}`)} <code>{text}</code>
      </legend>
      {mode === null ? (
        <p className="eui-hint">{t("builder.custom")}</p>
      ) : (
        <>
          <select
            className="eui-select"
            aria-label={t("builder.mode", { field: t(`fields.${name}`) })}
            value={mode.mode}
            onChange={(event) => {
              const next = event.target.value;
              onChange(
                next === "every"
                  ? { mode: "every" }
                  : next === "specific"
                    ? { mode: "specific", values: [min] }
                    : next === "range"
                      ? { mode: "range", from: min, to: top }
                      : {
                          mode: "step",
                          start: min,
                          every: name === "minute" || name === "second" ? 15 : 2,
                        },
              );
            }}
          >
            {(["every", "specific", "range", "step"] as const).map((value) => (
              <option key={value} value={value}>
                {t(`builder.modes.${value}`)}
              </option>
            ))}
          </select>
          {mode.mode === "specific" ? (
            <div className="cron-values" role="group" aria-label={t(`fields.${name}`)}>
              {options.map((value) => (
                <button
                  key={value}
                  type="button"
                  className="cron-value"
                  aria-pressed={mode.values.includes(value)}
                  onClick={() => {
                    const values = mode.values.includes(value)
                      ? mode.values.filter((entry) => entry !== value)
                      : [...mode.values, value];
                    onChange({ mode: "specific", values: values.length ? values : [value] });
                  }}
                >
                  {label(value)}
                </button>
              ))}
            </div>
          ) : mode.mode === "range" ? (
            <div className="cron-row">
              {numberInput(
                mode.from,
                (from) => onChange({ mode: "range", from, to: Math.max(from, mode.to) }),
                t("builder.from"),
              )}
              <span>–</span>
              {numberInput(
                mode.to,
                (to) => onChange({ mode: "range", from: Math.min(mode.from, to), to }),
                t("builder.to"),
              )}
            </div>
          ) : mode.mode === "step" ? (
            <div className="cron-row">
              <span>{t("builder.every")}</span>
              <input
                type="number"
                className="eui-input cron-number"
                aria-label={t("builder.interval")}
                min={1}
                max={top}
                value={mode.every}
                onChange={(event) => {
                  const every = Number(event.target.value);
                  if (every >= 1) onChange({ mode: "step", start: mode.start, every });
                }}
              />
              <span>{t("builder.startingAt")}</span>
              {numberInput(
                mode.start,
                (start) => onChange({ mode: "step", start, every: mode.every }),
                t("builder.start"),
              )}
            </div>
          ) : null}
        </>
      )}
    </fieldset>
  );
}
