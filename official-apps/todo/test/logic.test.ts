import { createApp } from "@everyos/app-sdk";
import { mountMockHost } from "@everyos/app-testing";
import { afterEach, describe, expect, it } from "vitest";
import { addDays, daysBetween, dueInstant, isDateKey } from "../src/dates.ts";
import {
  complete,
  createTask,
  dueReminders,
  inList,
  matches,
  parseQuickAdd,
  parseTask,
  reminderKey,
  sortTasks,
} from "../src/model.ts";
import { completedPerDay } from "../src/progress.tsx";
import { makeRecurrence, nextOccurrence } from "../src/recurrence.ts";
import { TodoStore } from "../src/store.ts";

const NOW = new Date(2026, 9, 21, 10, 0).getTime();
const TODAY = "2026-10-21";

describe("recurrence", () => {
  it("repeats daily, every n days and on weekdays", () => {
    expect(nextOccurrence(makeRecurrence("day", TODAY), TODAY)).toBe("2026-10-22");
    expect(nextOccurrence(makeRecurrence("day", TODAY, { interval: 3 }), TODAY)).toBe("2026-10-24");
    // Friday → Monday.
    expect(nextOccurrence(makeRecurrence("weekday", "2026-10-23"), "2026-10-23")).toBe(
      "2026-10-26",
    );
    expect(nextOccurrence(makeRecurrence("weekday", TODAY), TODAY)).toBe("2026-10-22");
  });

  it("repeats weekly on chosen days, every n weeks", () => {
    // 2026-10-21 is a Wednesday. Mondays and Fridays:
    const rule = makeRecurrence("week", TODAY, { weekdays: [1, 5] });
    expect(nextOccurrence(rule, TODAY)).toBe("2026-10-23");
    expect(nextOccurrence(rule, "2026-10-23")).toBe("2026-10-26");
    const fortnight = makeRecurrence("week", TODAY, { interval: 2, weekdays: [1, 5] });
    expect(nextOccurrence(fortnight, "2026-10-23")).toBe("2026-11-02");
    // Sunday ends the week (weeks run Monday to Sunday).
    expect(nextOccurrence(makeRecurrence("week", TODAY, { weekdays: [0, 3] }), TODAY)).toBe(
      "2026-10-25",
    );
    expect(nextOccurrence(makeRecurrence("week", TODAY), TODAY)).toBe("2026-10-28");
  });

  it("keeps month ends and leap days", () => {
    const monthly = makeRecurrence("month", "2026-01-31");
    expect(nextOccurrence(monthly, "2026-01-31")).toBe("2026-02-28");
    expect(nextOccurrence(monthly, "2026-02-28")).toBe("2026-03-31");
    expect(
      nextOccurrence(makeRecurrence("month", "2027-12-15", { interval: 3 }), "2027-12-15"),
    ).toBe("2028-03-15");
    const leap = makeRecurrence("year", "2028-02-29");
    expect(nextOccurrence(leap, "2028-02-29")).toBe("2029-02-28");
    expect(nextOccurrence(leap, "2031-02-28")).toBe("2032-02-29");
  });

  it("repeats on the same weekday of the month", () => {
    // 2026-10-13 is the 2nd Tuesday of October.
    const second = makeRecurrence("month", "2026-10-13", { monthMode: "weekday" });
    expect(nextOccurrence(second, "2026-10-13")).toBe("2026-11-10");
    // 2026-10-30 is the last Friday.
    const last = makeRecurrence("month", "2026-10-30", { monthMode: "weekday" });
    expect(nextOccurrence(last, "2026-10-30")).toBe("2026-11-27");
  });
});

describe("tasks", () => {
  it("completes a repeating task by moving it on and reopening its subtasks", () => {
    const task = createTask(
      {
        title: "Water plants",
        due: TODAY,
        recurrence: makeRecurrence("day", TODAY, { interval: 2 }),
        subtasks: [{ id: "s1", title: "Balcony", done: true }],
      },
      NOW,
    );
    const done = complete(task, NOW);
    expect(done).toMatchObject({ due: "2026-10-23", completedAt: null, completions: [NOW] });
    expect(done.subtasks[0]!.done).toBe(false);
    expect(complete(createTask({ title: "Once" }, NOW), NOW).completedAt).toBe(NOW);
  });

  it("sorts into smart lists", () => {
    const tasks = [
      createTask({ title: "overdue", due: "2026-10-19", projectId: "p" }, NOW),
      createTask({ title: "today", due: TODAY }, NOW),
      createTask({ title: "soon", due: "2026-10-25" }, NOW),
      createTask({ title: "later", due: "2026-11-30" }, NOW),
      { ...createTask({ title: "done", due: TODAY }, NOW), completedAt: NOW },
    ];
    const titles = (list: Parameters<typeof inList>[1]) =>
      tasks.filter((task) => inList(task, list, TODAY)).map((task) => task.title);
    expect(titles("today")).toEqual(["overdue", "today"]);
    expect(titles("overdue")).toEqual(["overdue"]);
    expect(titles("upcoming")).toEqual(["soon"]);
    expect(titles("inbox")).toEqual(["today", "soon", "later"]);
    expect(titles("completed")).toEqual(["done"]);
    expect(titles("all")).toHaveLength(4);
  });

  it("sorts by due date, priority and title", () => {
    const tasks = [
      createTask({ title: "b", due: "2026-10-25", priority: 1, order: 1 }, NOW),
      createTask({ title: "a", due: null, priority: 3, order: 2 }, NOW),
      createTask({ title: "c", due: "2026-10-22", dueTime: "08:00", priority: 0, order: 3 }, NOW),
    ];
    expect(sortTasks(tasks, "due", "en").map((task) => task.title)).toEqual(["c", "b", "a"]);
    expect(sortTasks(tasks, "priority", "en").map((task) => task.title)).toEqual(["a", "b", "c"]);
    expect(sortTasks(tasks, "title", "en").map((task) => task.title)).toEqual(["a", "b", "c"]);
    expect(sortTasks(tasks, "manual", "en").map((task) => task.title)).toEqual(["b", "a", "c"]);
  });

  it("parses quick adds, searches and validates stored tasks", () => {
    expect(parseQuickAdd("Buy milk #Home #errands now")).toEqual({
      title: "Buy milk now",
      tags: ["home", "errands"],
    });
    const task = createTask({ title: "Plan trip", notes: "Book hotel", tags: ["travel"] }, NOW);
    expect(matches(task, "hotel")).toBe(true);
    expect(matches(task, "#trav")).toBe(true);
    expect(matches(task, "pizza")).toBe(false);
    expect(parseTask({ id: "../x", title: "no" })).toBeNull();
    expect(parseTask({ ...task, priority: 9, due: "2026-02-30" })).toMatchObject({
      priority: 0,
      due: null,
    });
  });

  it("fires each reminder once, at the right time", () => {
    const task = createTask({ title: "Call", due: TODAY, dueTime: "10:30", remind: 15 }, NOW);
    expect(dueReminders([task], new Set(), NOW)).toEqual([]);
    const at = dueInstant(TODAY, "10:30") - 15 * 60_000;
    expect(dueReminders([task], new Set(), at)).toEqual([task]);
    expect(dueReminders([task], new Set([reminderKey(task)]), at)).toEqual([]);
    // Without a time, the reminder is for 09:00.
    const allDay = createTask({ title: "Pay", due: TODAY, remind: 0 }, NOW);
    expect(dueReminders([allDay], new Set(), new Date(2026, 9, 21, 9, 0).getTime())).toEqual([
      allDay,
    ]);
  });

  it("counts completions per day for the chart", () => {
    const task = { ...createTask({ title: "x" }, NOW), completions: [NOW, NOW - 86_400_000] };
    const days = completedPerDay(
      [task, { ...createTask({ title: "y" }, NOW), completedAt: NOW }],
      NOW,
    );
    expect(days.at(-1)).toEqual({ day: TODAY, count: 2 });
    expect(days.at(-2)!.count).toBe(1);
  });

  it("handles dates without time zone surprises", () => {
    expect(addDays("2026-03-28", 2)).toBe("2026-03-30");
    expect(daysBetween("2026-12-31", "2027-01-02")).toBe(2);
    expect(isDateKey("2026-02-29")).toBe(false);
  });
});

describe("the store", () => {
  let unmount = () => undefined as void;
  afterEach(() => unmount());

  it("keeps concurrent changes, moves tasks out of deleted projects and round-trips backups", async () => {
    const host = mountMockHost({ granted: ["storage:app"] });
    unmount = () => host.unmount();
    const store = new TodoStore(await createApp(), () => NOW);
    const project = await store.addProject("Home");
    const task = await store.put(createTask({ title: "Fix tap", projectId: project.id }, NOW));
    await Promise.all([
      store.change(task.id, (current) => ({ ...current, priority: 3 })),
      store.change(task.id, (current) => ({ ...current, tags: ["urgent"] })),
    ]);
    expect((await store.tasks())[0]).toMatchObject({ priority: 3, tags: ["urgent"] });
    for (let i = 0; i < 30; i += 1) await store.put(createTask({ title: `t${i}` }, NOW));
    expect(await store.tasks()).toHaveLength(31);
    await store.removeProject(project.id);
    expect((await store.tasks()).find((entry) => entry.id === task.id)?.projectId).toBeNull();
    const backup = await store.exportAll();
    unmount();

    const other = mountMockHost({ granted: ["storage:app"] });
    unmount = () => other.unmount();
    const fresh = new TodoStore(await createApp(), () => NOW);
    expect(await fresh.importBackup(JSON.parse(JSON.stringify(backup)))).toBe(31);
    expect(await fresh.importBackup(backup)).toBe(0);
    await expect(fresh.importBackup({ format: "x" })).rejects.toThrow(SyntaxError);
  });
});
