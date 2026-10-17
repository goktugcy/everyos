import { z } from "zod";
import { BATTERY_STATES, POWER_ACTIONS } from "../power.ts";
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
export const PowerActionSchema = z.enum(POWER_ACTIONS);
export const RebootStatusSchema = z.strictObject({
  source: z.enum(["host", "simulated"]),
  required: z.boolean(),
  reasons: z.array(z.enum(["flag", "kernel"])).max(2),
  packages: z.array(z.string().min(1).max(128)).max(200),
  kernel: z.string().max(128).nullable(),
});
export const PowerActionResultSchema = z.strictObject({
  source: z.enum(["host", "simulated"]),
  action: PowerActionSchema,
  at: z.number().int().nonnegative(),
});
/** Browser request: the action is repeated as confirmation and the password re-checked. */
export const PowerRequestSchema = z.strictObject({
  action: PowerActionSchema,
  confirm: PowerActionSchema,
  password: z.string().min(1).max(1024),
  /** Proceeds although other work is running (never during an EveryOS update). */
  force: z.boolean().optional(),
});
