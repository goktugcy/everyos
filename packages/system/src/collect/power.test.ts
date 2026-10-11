import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PowerStatusSchema } from "@otuken/shared/schemas";
import { afterEach, describe, expect, it } from "vitest";
import { collectPower } from "./power.ts";

const roots: string[] = [];
async function fixture(entries: Record<string, Record<string, string>>) {
  const root = await mkdtemp(join(tmpdir(), "otk-power-"));
  roots.push(root);
  for (const [id, fields] of Object.entries(entries)) {
    const directory = join(root, "sys/class/power_supply", id);
    await mkdir(directory, { recursive: true });
    await Promise.all(
      Object.entries(fields).map(([name, value]) => writeFile(join(directory, name), value)),
    );
  }
  return { paths: { root, platform: "linux" as const }, now: () => 42 };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Linux power readings", () => {
  it("converts kernel units and keeps measured power separate from charger limits", async () => {
    const result = await collectPower(
      await fixture({
        BAT0: {
          type: "Battery",
          capacity: "75",
          status: "Charging",
          power_now: "20000000",
          voltage_now: "12000000",
          current_now: "1500000",
          energy_now: "45000000",
          energy_full: "60000000",
        },
        AC: { type: "Mains", online: "1", input_power_limit: "65000000" },
        mouse: { type: "Battery", scope: "Device", capacity: "99", status: "Discharging" },
        BAT1: { type: "Battery", present: "0" },
      }),
    );
    expect(PowerStatusSchema.parse(result)).toEqual(result);
    expect(result).toMatchObject({ source: "host", at: 42, available: true, acConnected: true });
    expect(result.batteries).toHaveLength(1);
    expect(result.batteries[0]).toMatchObject({
      percent: 75,
      state: "charging",
      powerWatts: 20,
      voltageVolts: 12,
      currentAmps: 1.5,
      energyWh: 45,
      fullEnergyWh: 60,
    });
    expect(result.supplies).toEqual([
      { id: "AC", online: true, powerWatts: null, powerLimitWatts: 65 },
    ]);
  });

  it("derives watts from voltage and current without replacing missing readings with zero", async () => {
    const result = await collectPower(
      await fixture({
        BAT0: {
          type: "Battery",
          capacity: "invalid",
          status: "Discharging",
          voltage_now: "12000000",
          current_now: "-2000000",
        },
        AC: { type: "Mains", online: "0", voltage_max: "20000000", current_max: "3000000" },
        unknown: { type: "Battery", status: "Unknown", energy_now: "-1", power_now: "NaN" },
      }),
    );
    expect(PowerStatusSchema.parse(result)).toEqual(result);
    expect(result.acConnected).toBe(false);
    expect(result.batteries.find((battery) => battery.id === "BAT0")).toMatchObject({
      percent: null,
      powerWatts: 24,
      currentAmps: -2,
      energyWh: null,
    });
    expect(result.batteries.find((battery) => battery.id === "unknown")).toMatchObject({
      state: "unknown",
      powerWatts: null,
      energyWh: null,
    });
    expect(result.supplies[0]).toMatchObject({
      online: false,
      powerWatts: null,
      powerLimitWatts: 60,
    });
  });

  it("reports unavailable when Linux exposes no host power sensors", async () => {
    expect(await collectPower(await fixture({}))).toEqual({
      source: "host",
      at: 42,
      available: false,
      acConnected: null,
      batteries: [],
      supplies: [],
    });
  });
});
