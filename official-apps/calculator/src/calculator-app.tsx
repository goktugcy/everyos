import {
  Button,
  errorMessage,
  IconButton,
  Spacer,
  Tabs,
  Toolbar,
  ToolbarTitle,
  useApp,
  useI18n,
  useNarrow,
  usePersistentState,
  useT,
  useToast,
} from "@everyos/app-ui";
import { Copy, History } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Converter } from "./converter.tsx";
import { Decimal } from "./decimal.ts";
import { CalcError, evaluate, type AngleUnit } from "./expression.ts";
import {
  decimalSeparator,
  formatResult,
  resultExpression,
  toCanonical,
  toDisplay,
} from "./format.ts";
import { HistoryPanel, type HistoryEntry } from "./history.tsx";
import { Keypad, type KeyAction } from "./keypad.tsx";

type Mode = "standard" | "scientific" | "converter";
interface Settings {
  mode: Mode;
  angle: AngleUnit;
  showHistory: boolean;
}

const MAX_HISTORY = 200;

/** The text a key inserts, given what the field holds and whether a result is showing. */
function applyKey(
  action: KeyAction,
  field: string,
  shown: boolean,
  decimal: "." | ",",
): string | null {
  if (action.kind !== "insert") return null;
  const insert = action.text === "." ? decimal : toDisplay(action.text, decimal);
  // After "=", operators continue from the result; anything else starts a new calculation.
  if (shown && !/^[+\-×÷^!%−*/]/.test(action.text)) return insert;
  return field + insert;
}

export function CalculatorApp() {
  const app = useApp();
  const t = useT();
  const i18n = useI18n();
  const toast = useToast();
  const narrow = useNarrow(700);
  const decimal = decimalSeparator(i18n.tag);
  const [settings, setSettings] = usePersistentState<Settings>("settings", {
    mode: "standard",
    angle: "deg",
    showHistory: true,
  });
  const [history, setHistory] = usePersistentState<HistoryEntry[]>("history", []);
  const [memoryText, setMemoryText] = usePersistentState<string | null>("memory", null);
  // The field's text and whether it shows a result ("=" was pressed). The ref always holds the
  // latest value, so keys pressed faster than React renders build on each other.
  const [entry, setEntryState] = useState({ field: "", shown: false });
  const latest = useRef(entry);
  const setEntry = (
    next:
      | { field: string; shown: boolean }
      | ((current: { field: string; shown: boolean }) => {
          field: string;
          shown: boolean;
        }),
  ) => {
    latest.current = typeof next === "function" ? next(latest.current) : next;
    setEntryState(latest.current);
  };
  const { field, shown } = entry;
  const setField = (next: string | ((current: string) => string), showing = false) =>
    setEntry((current) => ({
      field: typeof next === "function" ? next(current.field) : next,
      shown: showing,
    }));
  const [ans, setAns] = useState<Decimal>(Decimal.ZERO);
  const [error, setError] = useState<CalcError | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const memory = memoryText === null ? null : Decimal.parse(memoryText);

  const calculate = useCallback(
    (text: string): Decimal => evaluate(toCanonical(text, decimal), { angle: settings.angle, ans }),
    [decimal, settings.angle, ans],
  );

  /** The live result while typing (errors appear only on "="). */
  const preview = useMemo(() => {
    if (!field.trim() || shown) return null;
    try {
      return calculate(field);
    } catch {
      return null;
    }
  }, [field, shown, calculate]);

  const current = (): Decimal => {
    const text = latest.current.field;
    if (!text.trim()) return ans;
    return calculate(text);
  };

  const describe = (caught: unknown) =>
    caught instanceof CalcError ? t(`errors.${caught.code}`) : errorMessage(t, caught);

  const equals = () => {
    const text = latest.current.field;
    if (!text.trim()) return;
    try {
      const value = calculate(text);
      const canonical = toCanonical(text, decimal);
      setHistory((list) =>
        [{ expression: canonical, result: resultExpression(value), at: Date.now() }, ...list].slice(
          0,
          MAX_HISTORY,
        ),
      );
      setAns(value);
      setField(toDisplay(resultExpression(value), decimal), true);
      setError(null);
    } catch (caught) {
      setError(caught instanceof CalcError ? caught : new CalcError("syntax"));
    }
  };

  const withValue = (run: (value: Decimal) => void) => {
    try {
      run(current());
      setError(null);
    } catch (caught) {
      setError(caught instanceof CalcError ? caught : new CalcError("syntax"));
    }
  };

  const press = (action: KeyAction) => {
    input.current?.focus();
    switch (action.kind) {
      case "insert":
        setEntry((current) => ({
          field: applyKey(action, current.field, current.shown, decimal) ?? current.field,
          shown: false,
        }));
        setError(null);
        return;
      case "equals":
        return equals();
      case "clear":
        setField("");
        setError(null);
        return;
      case "backspace":
        setEntry((current) => ({
          field: current.shown ? "" : current.field.slice(0, -1),
          shown: false,
        }));
        setError(null);
        return;
      case "negate":
        setField((value) => {
          const text = value.trim() || toDisplay(resultExpression(ans), decimal);
          const wrapped = /^-\((.*)\)$/.exec(text);
          return wrapped ? wrapped[1]! : `-(${text})`;
        });
        return;
      case "reciprocal":
        setField((value) => `1/(${value.trim() || toDisplay(resultExpression(ans), decimal)})`);
        return;
      case "random": {
        const random = toDisplay(resultExpression(Decimal.fromNumber(Math.random(), 10)), decimal);
        setEntry((current) => ({
          field: (current.shown ? "" : current.field) + random,
          shown: false,
        }));
        return;
      }
      case "memory-clear":
        setMemoryText(null);
        return;
      case "memory-recall": {
        if (!memory) return;
        const recalled = toDisplay(resultExpression(memory), decimal);
        setEntry((current) => ({
          field: (current.shown ? "" : current.field) + recalled,
          shown: false,
        }));
        return;
      }
      case "memory-store":
        return withValue((value) => setMemoryText(value.toString()));
      case "memory-add":
        return withValue((value) => setMemoryText((memory ?? Decimal.ZERO).add(value).toString()));
      case "memory-subtract":
        return withValue((value) => setMemoryText((memory ?? Decimal.ZERO).sub(value).toString()));
    }
  };

  const result = shown ? ans : preview;
  const copy = async () => {
    const value = result ?? (field.trim() ? null : ans);
    if (!value) return;
    try {
      await app.clipboard.writeText(formatResult(value, i18n.tag, false));
      toast(t("ui.copied"));
    } catch (caught) {
      toast(errorMessage(t, caught), "danger");
    }
  };

  // Keys typed anywhere in the window go to the field.
  useEffect(() => {
    if (settings.mode === "converter") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement && event.target !== input.current) return;
      if (event.target instanceof HTMLSelectElement || event.target instanceof HTMLButtonElement)
        if (event.key === "Enter" || event.key === " ") return;
      if (event.key === "Escape") {
        event.preventDefault();
        press({ kind: "clear" });
      } else if (event.key === "Enter" || event.key === "=") {
        event.preventDefault();
        equals();
      } else if (event.key === "Delete") {
        event.preventDefault();
        press({ kind: "clear" });
      } else if (
        document.activeElement !== input.current &&
        !event.metaKey &&
        !event.ctrlKey &&
        event.key.length === 1
      ) {
        input.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const showHistory = settings.showHistory && settings.mode !== "converter";
  return (
    <div className="calc" data-narrow={narrow || undefined}>
      <Toolbar label={t("app.name")}>
        <ToolbarTitle>{t("app.name")}</ToolbarTitle>
        <Tabs<Mode>
          label={t("modes.label")}
          value={settings.mode}
          onChange={(mode) => setSettings((current) => ({ ...current, mode }))}
          tabs={[
            { value: "standard", label: t("modes.standard") },
            { value: "scientific", label: t("modes.scientific") },
            { value: "converter", label: t("modes.converter") },
          ]}
        />
        <Spacer />
        {settings.mode === "scientific" ? (
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={settings.angle === "rad"}
            title={t("angle.toggle")}
            onClick={() =>
              setSettings((current) => ({
                ...current,
                angle: current.angle === "deg" ? "rad" : "deg",
              }))
            }
          >
            {settings.angle === "deg" ? t("angle.deg") : t("angle.rad")}
          </Button>
        ) : null}
        {settings.mode !== "converter" ? (
          <IconButton
            label={t("history.toggle")}
            pressed={settings.showHistory}
            icon={<History size={16} aria-hidden />}
            onClick={() =>
              setSettings((current) => ({ ...current, showHistory: !current.showHistory }))
            }
          />
        ) : null}
      </Toolbar>
      {settings.mode === "converter" ? (
        <Converter decimal={decimal} />
      ) : (
        <div className="calc-body" data-history={showHistory || undefined}>
          <section className="calc-main" aria-label={t("app.name")}>
            <div className="calc-display">
              <div className="calc-memory" aria-live="polite">
                {memory ? (
                  <span title={t("memory.value")}>M = {formatResult(memory, i18n.tag)}</span>
                ) : null}
                {settings.mode === "scientific" ? (
                  <span className="calc-angle">{settings.angle.toUpperCase()}</span>
                ) : null}
              </div>
              <input
                ref={input}
                className="calc-field"
                aria-label={t("display.expression")}
                value={field}
                autoFocus
                spellCheck={false}
                autoComplete="off"
                inputMode="decimal"
                onChange={(event) => {
                  setField(event.target.value);
                  setError(null);
                }}
              />
              <div className="calc-result-row">
                <output
                  className="calc-result"
                  aria-label={t("display.result")}
                  data-error={error ? true : undefined}
                  data-preview={!shown || undefined}
                >
                  {error ? describe(error) : result ? formatResult(result, i18n.tag) : " "}
                </output>
                <IconButton
                  size="sm"
                  label={t("actions.copy")}
                  icon={<Copy size={14} aria-hidden />}
                  disabled={!result}
                  onClick={() => void copy()}
                />
              </div>
            </div>
            <Keypad scientific={settings.mode === "scientific"} decimal={decimal} onPress={press} />
          </section>
          {showHistory ? (
            <HistoryPanel
              entries={history}
              decimal={decimal}
              onUse={(text) => {
                setField(toDisplay(text, decimal));
                setError(null);
                input.current?.focus();
              }}
              onClear={async () => {
                if (
                  await app.dialogs.confirm(t("history.clearTitle"), t("ui.deleteBody"), {
                    confirm: t("history.clear"),
                    destructive: true,
                  })
                )
                  setHistory([]);
              }}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}
