import {
  HOME_ASSISTANT_SIMPLE_SERVICES,
  type HomeAssistantAction,
  type HomeAssistantEntity,
} from "@everyos/shared";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button.tsx";
import { Field } from "../../components/ui/field.tsx";
import { Select } from "../../components/ui/select.tsx";
import { api } from "../../lib/api.ts";
import { errorMessage } from "../../lib/errors.ts";
import { requestConfirm } from "../../desktop/menus/confirm.tsx";
import { ControlField } from "./control-field.tsx";

export function EntityControls({
  integrationId,
  entity,
  compact = false,
  quick = false,
}: {
  integrationId: string;
  entity: HomeAssistantEntity;
  compact?: boolean;
  quick?: boolean;
}) {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [error, setError] = useState<unknown>(null);
  const [accepted, setAccepted] = useState(false);
  const [number, setNumber] = useState("");
  const [option, setOption] = useState("");
  const unavailable = entity.state === "unknown" || entity.state === "unavailable";
  const run = async (action: HomeAssistantAction) => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    setAccepted(false);
    try {
      if (
        action.service === "unlock" ||
        (action.service === "open" && entity.entityId.startsWith("lock."))
      ) {
        if (
          !(await requestConfirm({
            title: t("homeAssistant.unlockTitle", { name: entity.name ?? entity.entityId }),
            body: t("homeAssistant.unlockBody"),
            confirmLabel: t(`homeAssistant.actions.${action.service}`),
            danger: true,
          }))
        )
          return;
        action = { ...action, confirm: true };
      }
      await api(`/integrations/${integrationId}/actions`, { method: "POST", body: action });
      setAccepted(true);
    } catch (caught) {
      setError(caught);
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };
  const simple = HOME_ASSISTANT_SIMPLE_SERVICES.filter((service) =>
    entity.actions.includes(service),
  )
    .filter(
      (service) =>
        !entity.actions.includes("toggle") || (service !== "turn_on" && service !== "turn_off"),
    )
    .filter((service) => !quick || service === "toggle");
  const numeric =
    !quick && entity.actions.includes("set_temperature")
      ? "set_temperature"
      : !quick && entity.actions.includes("set_value")
        ? "set_value"
        : null;
  const selection =
    !quick && entity.actions.includes("set_hvac_mode")
      ? "set_hvac_mode"
      : !quick && entity.actions.includes("select_option")
        ? "select_option"
        : null;
  return (
    <div className="flex flex-col gap-2" role="group" aria-label={entity.name ?? entity.entityId}>
      <div className="flex flex-wrap gap-1.5">
        {simple.map((service) => (
          <Button
            key={service}
            size="sm"
            variant="secondary"
            disabled={pending || unavailable}
            onClick={() => void run({ entityId: entity.entityId, service })}
          >
            {t(`homeAssistant.actions.${service}`)}
          </Button>
        ))}
      </div>
      {numeric ? (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!number.trim() || !Number.isFinite(Number(number))) return;
            void run(
              numeric === "set_temperature"
                ? { entityId: entity.entityId, service: numeric, temperature: Number(number) }
                : { entityId: entity.entityId, service: numeric, value: Number(number) },
            );
          }}
        >
          <div className="min-w-28 flex-1">
            <Field
              label={t(
                numeric === "set_temperature"
                  ? "homeAssistant.targetTemperature"
                  : "homeAssistant.value",
              )}
              type="number"
              value={number}
              placeholder={
                numeric === "set_temperature"
                  ? String(entity.targetTemperature ?? "")
                  : entity.state
              }
              min={entity.min ?? undefined}
              max={entity.max ?? undefined}
              step={entity.step && entity.step > 0 ? entity.step : "any"}
              required
              disabled={pending || unavailable}
              onChange={(event) => setNumber(event.target.value)}
            />
          </div>
          <Button
            type="submit"
            size="sm"
            variant="secondary"
            disabled={pending || unavailable || !number.trim()}
          >
            {t(`homeAssistant.actions.${numeric}`)}
          </Button>
        </form>
      ) : null}
      {selection ? (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const chosen = option || entity.options[0];
            if (!chosen) return;
            void run(
              selection === "set_hvac_mode"
                ? { entityId: entity.entityId, service: selection, hvacMode: chosen }
                : { entityId: entity.entityId, service: selection, option: chosen },
            );
          }}
        >
          <div className="min-w-28 flex-1">
            <Select
              label={t(
                selection === "set_hvac_mode" ? "homeAssistant.hvacMode" : "homeAssistant.option",
              )}
              value={option || entity.options[0] || ""}
              options={entity.options.map((value) => ({ value, label: value }))}
              onChange={setOption}
              disabled={pending || unavailable}
            />
          </div>
          <Button type="submit" size="sm" variant="secondary" disabled={pending || unavailable}>
            {t(`homeAssistant.actions.${selection}`)}
          </Button>
        </form>
      ) : null}
      {!quick && entity.controls?.length ? (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,220px),1fr))] gap-3">
          {entity.controls.map((control) => (
            <ControlField
              key={control.id}
              control={control}
              disabled={pending || unavailable}
              onApply={(value) =>
                void run({
                  entityId: entity.entityId,
                  service: "configure",
                  control: control.id,
                  value,
                })
              }
            />
          ))}
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {errorMessage(t, error)}
        </p>
      ) : null}
      {accepted && !compact ? (
        <p role="status" className="text-xs text-fg-muted">
          {t("homeAssistant.accepted")}
        </p>
      ) : null}
    </div>
  );
}
