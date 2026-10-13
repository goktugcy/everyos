import type { HomeAssistantControl, HomeAssistantControlValue } from "@everyos/shared";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button.tsx";
import { Field } from "../../components/ui/field.tsx";
import { Select } from "../../components/ui/select.tsx";

const colorHex = (rgb: [number, number, number]) =>
  `#${rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
const OPTION_LABELS = ["forward", "reverse", "short", "long", "off", "all", "one"] as const;

/** Draft edits do not send commands until Apply. The reported value follows live state. */
export function ControlField({
  control,
  disabled,
  onApply,
}: {
  control: HomeAssistantControl;
  disabled: boolean;
  onApply: (value: HomeAssistantControlValue) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<string | null>(null);
  const label = t(`homeAssistant.controls.${control.id}`);
  if (control.kind === "temperatureRange")
    return <TemperatureRangeField control={control} disabled={disabled} onApply={onApply} />;
  const current =
    control.kind === "color" && control.value
      ? colorHex(control.value)
      : control.value === null
        ? ""
        : control.kind === "number"
          ? String(Number(control.value.toFixed(2)))
          : String(control.value);
  const value =
    draft ??
    (control.kind === "number" && control.step === 1 && control.value !== null
      ? String(Math.round(control.value))
      : current);
  const options =
    control.kind === "choice"
      ? control.options.map((option) => {
          const known = OPTION_LABELS.find((value) => value === option);
          return {
            value: String(option),
            label: known ? t(`homeAssistant.controlOptions.${known}`) : String(option),
          };
        })
      : control.kind === "boolean"
        ? [
            { value: "true", label: t("homeAssistant.states.on") },
            { value: "false", label: t("homeAssistant.states.off") },
          ]
        : [];
  const valid =
    control.kind === "number"
      ? value.trim() !== "" &&
        Number.isFinite(Number(value)) &&
        Number(value) >= control.min &&
        Number(value) <= control.max &&
        (control.step !== 1 || Number.isInteger(Number(value)))
      : control.kind === "color"
        ? /^#[0-9a-f]{6}$/i.test(value)
        : options.some((option) => option.value === value);
  const apply = () => {
    if (!valid) return;
    const parsed =
      control.kind === "number"
        ? Number(value)
        : control.kind === "boolean"
          ? value === "true"
          : control.kind === "color"
            ? ([1, 3, 5].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16)) as [
                number,
                number,
                number,
              ])
            : control.kind === "choice"
              ? control.options.find((option) => String(option) === value)!
              : value;
    onApply(parsed);
  };
  return (
    <form
      className="rounded-everyos-md border border-line bg-hover/3 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        apply();
      }}
    >
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-32 flex-1">
          {control.kind === "choice" || control.kind === "boolean" ? (
            <Select
              label={label}
              value={value}
              options={[
                ...(!value ? [{ value: "", label: t("homeAssistant.chooseSetting") }] : []),
                ...options,
              ]}
              disabled={disabled}
              onChange={setDraft}
            />
          ) : (
            <Field
              label={
                control.kind === "number" && control.unit ? `${label} (${control.unit})` : label
              }
              type={control.kind === "color" ? "color" : "number"}
              value={control.kind === "color" ? value || "#ffffff" : value}
              placeholder={t("homeAssistant.notReported")}
              min={control.kind === "number" ? control.min : undefined}
              max={control.kind === "number" ? control.max : undefined}
              step={control.kind === "number" ? control.step : undefined}
              disabled={disabled}
              required
              onChange={(event) => setDraft(event.target.value)}
            />
          )}
        </div>
        <Button type="submit" size="sm" variant="secondary" disabled={disabled || !valid}>
          {t("homeAssistant.apply")}
        </Button>
      </div>
      {control.kind === "number" &&
      [
        "brightness",
        "percentage",
        "position",
        "tilt",
        "valvePosition",
        "colorTemperature",
        "volume",
        "sirenVolume",
      ].includes(control.id) ? (
        <input
          type="range"
          className="mt-3 w-full accent-[rgb(var(--everyos-accent))]"
          aria-label={t("homeAssistant.adjustSetting", { name: label })}
          min={control.min}
          max={control.max}
          step={control.step}
          value={value || control.min}
          disabled={disabled}
          onChange={(event) => setDraft(event.target.value)}
        />
      ) : null}
      <p className="mt-2 text-xs text-fg-subtle">
        {t("homeAssistant.reportedSetting", {
          value:
            control.kind === "boolean" && control.value !== null
              ? t(control.value ? "homeAssistant.states.on" : "homeAssistant.states.off")
              : current || t("homeAssistant.notReported"),
        })}
      </p>
    </form>
  );
}

function TemperatureRangeField({
  control,
  disabled,
  onApply,
}: {
  control: Extract<HomeAssistantControl, { kind: "temperatureRange" }>;
  disabled: boolean;
  onApply: (value: HomeAssistantControlValue) => void;
}) {
  const { t } = useTranslation();
  const [low, setLow] = useState<string | null>(null);
  const [high, setHigh] = useState<string | null>(null);
  const lower = low ?? String(control.value?.[0] ?? ""),
    upper = high ?? String(control.value?.[1] ?? "");
  const valid =
    lower !== "" &&
    upper !== "" &&
    Number.isFinite(Number(lower)) &&
    Number.isFinite(Number(upper)) &&
    Number(lower) >= control.min &&
    Number(upper) <= control.max &&
    Number(lower) <= Number(upper);
  return (
    <form
      className="rounded-everyos-md border border-line p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) onApply([Number(lower), Number(upper)]);
      }}
    >
      <div className="grid grid-cols-2 gap-2">
        <Field
          label={t("homeAssistant.temperatureLow")}
          type="number"
          value={lower}
          min={control.min}
          max={control.max}
          step={control.step}
          disabled={disabled}
          required
          onChange={(event) => setLow(event.target.value)}
        />
        <Field
          label={t("homeAssistant.temperatureHigh")}
          type="number"
          value={upper}
          min={control.min}
          max={control.max}
          step={control.step}
          disabled={disabled}
          required
          onChange={(event) => setHigh(event.target.value)}
        />
      </div>
      <Button
        type="submit"
        className="mt-3"
        size="sm"
        variant="secondary"
        disabled={disabled || !valid}
      >
        {t("homeAssistant.apply")}
      </Button>
    </form>
  );
}
