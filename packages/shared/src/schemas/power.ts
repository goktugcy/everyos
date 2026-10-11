import { z } from "zod";
import { BATTERY_STATES } from "../power.ts";
const reading = z.number().finite().nonnegative().nullable();
export const PowerStatusSchema = z.strictObject({
  source: z.literal("host"),
  at: z.number().int().nonnegative(),
  available: z.boolean(),
  acConnected: z.boolean().nullable(),
  batteries: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(128),
        percent: z.number().min(0).max(100).nullable(),
        state: z.enum(BATTERY_STATES),
        powerWatts: reading,
        voltageVolts: reading,
        currentAmps: z.number().finite().nullable(),
        energyWh: reading,
        fullEnergyWh: reading,
        timeToEmptySeconds: reading,
        timeToFullSeconds: reading,
      }),
    )
    .max(32),
  supplies: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(128),
        online: z.boolean().nullable(),
        powerWatts: reading,
        powerLimitWatts: reading,
      }),
    )
    .max(32),
});
