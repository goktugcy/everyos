import { IconButton, Select, TextField, useI18n, usePersistentState, useT } from "@everyos/app-ui";
import { ArrowLeftRight } from "lucide-react";
import { useMemo } from "react";
import { Decimal } from "./decimal.ts";
import { CalcError, evaluate } from "./expression.ts";
import { formatResult, toCanonical } from "./format.ts";
import { CATEGORIES, category, convert } from "./units.ts";

interface ConverterState {
  category: string;
  from: string;
  to: string;
  value: string;
}

const DEFAULTS: Record<string, [string, string]> = {
  length: ["m", "ft"],
  area: ["m2", "ft2"],
  volume: ["l", "gal"],
  mass: ["kg", "lb"],
  temperature: ["c", "f"],
  speed: ["kph", "mph"],
  time: ["h", "min"],
  data: ["GB", "GiB"],
  pressure: ["bar", "psi"],
  energy: ["kWh", "kJ"],
  angle: ["deg", "rad"],
};

export function Converter({ decimal }: { decimal: "." | "," }) {
  const t = useT();
  const i18n = useI18n();
  const [state, setState] = usePersistentState<ConverterState>("converter", {
    category: "length",
    from: "m",
    to: "ft",
    value: "1",
  });
  const current = category(state.category) ?? CATEGORIES[0]!;
  const options = current.units.map((unit) => ({
    value: unit.id,
    label: `${t(`units.${current.id}.${unit.id}`)} (${unit.symbol})`,
  }));

  const input = useMemo((): Decimal | CalcError | null => {
    if (!state.value.trim()) return null;
    try {
      return evaluate(toCanonical(state.value, decimal), { angle: "deg" });
    } catch (error) {
      return error instanceof CalcError ? error : new CalcError("syntax");
    }
  }, [state.value, decimal]);

  const value = input instanceof Decimal ? input : null;
  const result = value ? convert(current.id, value, state.from, state.to) : null;

  return (
    <div className="calc-converter">
      <Select
        label={t("converter.category")}
        value={current.id}
        options={CATEGORIES.map((entry) => ({
          value: entry.id,
          label: t(`categories.${entry.id}`),
        }))}
        onChange={(id) => {
          const [from, to] = DEFAULTS[id] ?? ["", ""];
          setState((previous) => ({ ...previous, category: id, from, to }));
        }}
      />
      <div className="calc-converter-row">
        <TextField
          label={t("converter.value")}
          value={state.value}
          inputMode="decimal"
          aria-invalid={input instanceof CalcError || undefined}
          onChange={(event) => setState((previous) => ({ ...previous, value: event.target.value }))}
        />
        <Select
          label={t("converter.from")}
          value={state.from}
          options={options}
          onChange={(from) => setState((previous) => ({ ...previous, from }))}
        />
        <IconButton
          label={t("converter.swap")}
          icon={<ArrowLeftRight size={16} aria-hidden />}
          onClick={() =>
            setState((previous) => ({ ...previous, from: previous.to, to: previous.from }))
          }
        />
        <Select
          label={t("converter.to")}
          value={state.to}
          options={options}
          onChange={(to) => setState((previous) => ({ ...previous, to }))}
        />
      </div>
      <output className="calc-converter-result" aria-label={t("converter.result")}>
        {input instanceof CalcError
          ? t(`errors.${input.code}`)
          : result
            ? `${formatResult(result, i18n.tag)} ${current.units.find((unit) => unit.id === state.to)?.symbol ?? ""}`
            : " "}
      </output>
      {value ? (
        <table className="eui-table calc-converter-table" aria-label={t("converter.all")}>
          <tbody>
            {current.units.map((unit) => (
              <tr key={unit.id} aria-selected={unit.id === state.to || undefined}>
                <td>{t(`units.${current.id}.${unit.id}`)}</td>
                <td className="calc-number">
                  {formatResult(convert(current.id, value, state.from, unit.id), i18n.tag)}{" "}
                  {unit.symbol}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}
