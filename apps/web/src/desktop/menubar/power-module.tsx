import type { PowerStatus } from "@otuken/shared";
import { Battery, BatteryLow, BatteryMedium, BatteryFull, PlugZap } from "lucide-react";
import { Popover } from "radix-ui";
import { useTranslation } from "react-i18next";
import { Alert } from "../../components/ui/alert.tsx";
import { useApiResource } from "../../features/system/use-api-resource.ts";
import { errorMessage } from "../../lib/errors.ts";
import { formatNumber, formatPercent, formatDateTime } from "../../lib/format.ts";
import { DefinitionRows } from "../apps/system/parts.tsx";
import { menubarButton } from "./menubar-button.ts";

/** Managed Linux host readings, independent of the browser device's battery. */
export function PowerModule() {
  const { t, i18n } = useTranslation();
  const power = useApiResource<PowerStatus>("/system/power", 15_000);
  const data = power.data;
  const percent = data?.batteries[0]?.percent ?? null;
  const Icon =
    data?.acConnected === true
      ? PlugZap
      : percent === null
        ? Battery
        : percent <= 20
          ? BatteryLow
          : percent <= 70
            ? BatteryMedium
            : BatteryFull;
  const unknown = t("power.unknown");
  const quantity = (value: number | null, unit: "watts" | "volts" | "amps" | "wattHours") =>
    value === null ? unknown : t(`power.${unit}`, { value: formatNumber(value, i18n.language, 1) });
  const label = `${t("power.title")}: ${percent !== null ? formatPercent(percent, i18n.language) : data?.acConnected === true ? t("power.pluggedIn") : unknown}`;
  return (
    <Popover.Root>
      <Popover.Trigger
        className={menubarButton}
        aria-label={label}
        title={label}
        data-testid="menubar-power"
      >
        <Icon
          className={
            percent !== null && percent <= 20 && data?.acConnected === false
              ? "size-4 text-warning"
              : "size-4"
          }
          aria-hidden
        />
        {percent !== null ? (
          <span className="hidden tabular-nums md:inline">
            {formatPercent(percent, i18n.language)}
          </span>
        ) : null}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={8}
          collisionPadding={8}
          className="glass-strong otk-enter z-[8000] flex max-h-[80dvh] w-80 flex-col gap-3 overflow-y-auto rounded-otk-lg p-4 text-sm text-fg"
        >
          <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">
            {t("power.title")}
          </h3>
          {power.error ? <Alert tone="danger">{errorMessage(t, power.error)}</Alert> : null}
          {power.loading ? (
            <p>{t("common.loading")}</p>
          ) : data?.available ? (
            <>
              <DefinitionRows
                rows={[
                  [
                    t("power.source"),
                    data.acConnected === true
                      ? t("power.pluggedIn")
                      : data.acConnected === false
                        ? t("power.onBattery")
                        : unknown,
                  ],
                ]}
              />
              {data.batteries.map((battery) => (
                <section key={battery.id} className="flex flex-col gap-2 border-t border-line pt-3">
                  <h4 className="font-semibold">{t("power.battery", { name: battery.id })}</h4>
                  <DefinitionRows
                    rows={[
                      [
                        t("power.level"),
                        battery.percent === null
                          ? unknown
                          : formatPercent(battery.percent, i18n.language),
                      ],
                      [t("power.state"), t(`power.states.${battery.state}`)],
                      [t("power.batteryPower"), quantity(battery.powerWatts, "watts")],
                      [t("power.energy"), quantity(battery.energyWh, "wattHours")],
                      [t("power.fullEnergy"), quantity(battery.fullEnergyWh, "wattHours")],
                      [t("power.voltage"), quantity(battery.voltageVolts, "volts")],
                      [t("power.current"), quantity(battery.currentAmps, "amps")],
                    ]}
                  />
                </section>
              ))}
              {data.supplies.map((supply) => (
                <section key={supply.id} className="flex flex-col gap-2 border-t border-line pt-3">
                  <h4 className="font-semibold">{t("power.adapter", { name: supply.id })}</h4>
                  <DefinitionRows
                    rows={[
                      [
                        t("power.connection"),
                        supply.online === true
                          ? t("power.connected")
                          : supply.online === false
                            ? t("power.disconnected")
                            : unknown,
                      ],
                      [t("power.measuredPower"), quantity(supply.powerWatts, "watts")],
                      [t("power.powerLimit"), quantity(supply.powerLimitWatts, "watts")],
                    ]}
                  />
                </section>
              ))}
              <p className="text-xs text-fg-muted">{t("power.measurementHint")}</p>
              <p className="text-xs text-fg-subtle">
                {t("power.updated", { time: formatDateTime(data.at, i18n.language) })}
              </p>
            </>
          ) : (
            <p className="text-fg-muted">{t("power.unavailable")}</p>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
