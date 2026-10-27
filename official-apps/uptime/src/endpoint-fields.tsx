import { Checkbox, TextField, useT } from "@everyos/app-ui";
import type { EndpointDraft } from "./uptime.ts";

export function EndpointFields({
  draft,
  disabled,
  onChange,
}: {
  draft: EndpointDraft;
  disabled: boolean;
  onChange: (patch: Partial<EndpointDraft>) => void;
}) {
  const t = useT();
  const field = (
    key: "name" | "url" | "interval" | "timeout" | "min" | "max" | "downAfter",
    min?: number,
    max?: number,
  ) => (
    <TextField
      label={t(`form.${key}`)}
      value={draft[key]}
      type={min === undefined ? "text" : "number"}
      {...(min === undefined ? {} : { min, max, step: 1 })}
      disabled={disabled}
      onChange={(event) => onChange({ [key]: event.target.value })}
    />
  );
  return (
    <>
      <p className="uptime-hint">{t("form.policy")}</p>
      <p className="uptime-hint">{t("endpoints.method")}</p>
      <div className="uptime-form">
        {field("name")}
        {field("url")}
        {field("interval", 60, 86400)}
        {field("timeout", 1000, 30000)}
        {field("min", 100, 599)}
        {field("max", 100, 599)}
        {field("downAfter", 1, 5)}
      </div>
      <Checkbox
        label={t("form.notify")}
        checked={draft.notify}
        disabled={disabled}
        onChange={(notify) => onChange({ notify })}
      />
      <Checkbox
        label={t("form.enabled")}
        checked={draft.enabled}
        disabled={disabled}
        onChange={(enabled) => onChange({ enabled })}
      />
    </>
  );
}
