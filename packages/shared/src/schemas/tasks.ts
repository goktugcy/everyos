import { z } from "zod";
import { cronTooFrequent, parseCron } from "../cron.ts";
import { UnitNameSchema } from "./host.ts";

export const CronExpressionSchema = z
  .string()
  .trim()
  .max(100)
  .refine((value) => parseCron(value) !== null, "invalid-schedule")
  .refine((value) => {
    const schedule = parseCron(value);
    return !schedule || !cronTooFrequent(schedule);
  }, "too-frequent");

/** Per-type parameters (every task type has a strict, closed parameter set). */
export const TaskDefinitionSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("updates.refresh"), params: z.strictObject({}) }),
  z.strictObject({ type: z.literal("updates.security"), params: z.strictObject({}) }),
  z.strictObject({
    type: z.literal("service.restart"),
    params: z.strictObject({ unit: UnitNameSchema }),
  }),
  z.strictObject({
    type: z.literal("container.restart"),
    params: z.strictObject({ container: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/) }),
  }),
  z.strictObject({
    type: z.literal("app.update"),
    params: z.strictObject({ appId: z.string().uuid() }),
  }),
  z.strictObject({ type: z.literal("backup.create"), params: z.strictObject({}) }),
]);

const common = {
  name: z.string().trim().min(1).max(80),
  schedule: CronExpressionSchema,
  enabled: z.boolean().default(true),
  notify: z.enum(["failure", "always", "never"]).default("failure"),
  catchUp: z.boolean().default(true),
};

export const TaskCreateRequestSchema = z.intersection(z.strictObject(common), TaskDefinitionSchema);

export const TaskUpdateRequestSchema = z.strictObject({
  name: common.name.optional(),
  schedule: CronExpressionSchema.optional(),
  enabled: z.boolean().optional(),
  notify: common.notify.unwrap().optional(),
  catchUp: z.boolean().optional(),
});

/** `GET /api/tasks/calendar?from=&to=` (epoch ms, at most 62 days). */
export const TaskCalendarQuerySchema = z
  .strictObject({
    from: z.coerce.number().int().nonnegative(),
    to: z.coerce.number().int().nonnegative(),
  })
  .refine(
    (value) => value.to > value.from && value.to - value.from <= 62 * 24 * 60 * 60_000,
    "range",
  );
