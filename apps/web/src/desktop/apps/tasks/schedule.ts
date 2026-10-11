import { nextRun, parseCron } from "@otuken/shared";

/** Schedule presets offered by the editor; anything else is a custom cron expression. */
export type ScheduleForm =
  | { mode: "hourly"; minute: number }
  | { mode: "daily"; hour: number; minute: number }
  | { mode: "weekly"; weekday: number; hour: number; minute: number }
  | { mode: "monthly"; day: number; hour: number; minute: number }
  | { mode: "custom"; expression: string };

export function toCron(form: ScheduleForm): string {
  switch (form.mode) {
    case "hourly":
      return `${form.minute} * * * *`;
    case "daily":
      return `${form.minute} ${form.hour} * * *`;
    case "weekly":
      return `${form.minute} ${form.hour} * * ${form.weekday}`;
    case "monthly":
      return `${form.minute} ${form.hour} ${form.day} * *`;
    case "custom":
      return form.expression.trim();
  }
}

const NUMBER = /^\d{1,2}$/;

/** Recognizes the presets in an expression (for editing and display). */
export function fromCron(expression: string): ScheduleForm {
  const [minute, hour, day, month, weekday] = expression.trim().split(/\s+/);
  const m = Number(minute);
  const h = Number(hour);
  if (minute && NUMBER.test(minute) && month === "*") {
    if (hour === "*" && day === "*" && weekday === "*") return { mode: "hourly", minute: m };
    if (hour && NUMBER.test(hour)) {
      if (day === "*" && weekday === "*") return { mode: "daily", hour: h, minute: m };
      if (day === "*" && weekday && /^[0-7]$/.test(weekday))
        return { mode: "weekly", weekday: Number(weekday) % 7, hour: h, minute: m };
      if (day && NUMBER.test(day) && weekday === "*")
        return { mode: "monthly", day: Number(day), hour: h, minute: m };
    }
  }
  return { mode: "custom", expression };
}

/** Next run of an expression from now, or null when it is invalid or never runs. */
export function previewNext(expression: string, now = Date.now()): number | null {
  const schedule = parseCron(expression);
  return schedule ? nextRun(schedule, now) : null;
}

export const pad = (value: number) => String(value).padStart(2, "0");
