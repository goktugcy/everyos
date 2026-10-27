import { renderApp, type RenderedApp } from "@everyos/app-ui/testing";
import { byRole, byText, typeInto } from "@everyos/app-testing/dom";
import type { MockHostOptions } from "@everyos/app-testing";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { todayKey } from "../src/dates.ts";
import { createTask, type Task } from "../src/model.ts";
import { makeRecurrence } from "../src/recurrence.ts";
import { TaskWidget } from "../src/task-widget.tsx";
import { TodoApp } from "../src/todo-app.tsx";

const publicDir = join(import.meta.dirname, "../public");
let rendered: RenderedApp | null = null;
afterEach(() => {
  rendered?.unmount();
  rendered = null;
});

async function start(options: MockHostOptions = {}, Root = TodoApp) {
  rendered = await renderApp(Root, {
    publicDir,
    app: { id: "dev.everyos.todo", version: "1.0.0", name: "To-Do" },
    granted: ["storage:app", "notifications:send", "widgets:register", "files:pick", "files:save"],
    ...options,
  });
  return rendered;
}

const stored = (host: RenderedApp["host"]) =>
  [...host.storage.entries()]
    .filter(([key]) => key.startsWith("tasks/"))
    .flatMap(([, value]) => value as Task[]);
const rows = () => [...document.querySelectorAll(".todo-row-title")].map((row) => row.textContent);
async function click(role: string, name: string | RegExp) {
  await vi.waitFor(() => expect(byRole(role, name)).not.toBeNull());
  byRole(role, name)!.click();
}

describe("To-Do", () => {
  it("adds tasks with tags to today, completes them and shows them as completed", async () => {
    const { host } = await start({ locale: "tr" });
    await vi.waitFor(() => expect(byText("Bugün yapılacak bir şey yok")).not.toBeNull());
    typeInto(byRole("textbox", "Yeni görev"), "Faturayı öde #ev");
    await click("button", "Ekle");
    await vi.waitFor(() => expect(rows()).toEqual(["Faturayı öde"]));
    await vi.waitFor(() =>
      expect(stored(host)[0]).toMatchObject({
        title: "Faturayı öde",
        tags: ["ev"],
        due: todayKey(),
      }),
    );
    (document.querySelector(".todo-check") as HTMLInputElement).click();
    await vi.waitFor(() => expect(stored(host)[0]!.completedAt).not.toBeNull());
    await vi.waitFor(() => expect(rows()).toEqual([]));
    await click("button", /Tamamlananlar/);
    await vi.waitFor(() => expect(rows()).toEqual(["Faturayı öde"]));
  });

  it("edits a task: priority, due date, repeat, subtasks", async () => {
    const task = createTask({ title: "Gym", due: todayKey() }, Date.now());
    const { host } = await start({ storage: { "tasks/0": [task] } });
    await vi.waitFor(() => expect(rows()).toEqual(["Gym"]));
    (document.querySelector(".todo-row-main") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(byRole("combobox", "Priority")).not.toBeNull());
    const priority = byRole("combobox", "Priority") as HTMLSelectElement;
    priority.value = "3";
    priority.dispatchEvent(new Event("change", { bubbles: true }));
    const repeat = byRole("combobox", "Repeats") as HTMLSelectElement;
    repeat.value = "day";
    repeat.dispatchEvent(new Event("change", { bubbles: true }));
    const subtask = byRole("textbox", "Add a subtask") as HTMLInputElement;
    typeInto(subtask, "Stretch");
    subtask.form!.requestSubmit();
    await vi.waitFor(() =>
      expect(stored(host)[0]).toMatchObject({
        priority: 3,
        recurrence: { unit: "day", interval: 1 },
        subtasks: [expect.objectContaining({ title: "Stretch", done: false })],
      }),
    );
    // Completing a daily task moves it to tomorrow.
    await click("checkbox", "Mark as done");
    await vi.waitFor(() =>
      expect(stored(host)[0]).toMatchObject({
        completedAt: null,
        completions: [expect.any(Number)],
      }),
    );
    expect(stored(host)[0]!.due).not.toBe(todayKey());
  });

  it("organizes tasks in projects and finds them", async () => {
    const { host } = await start();
    await click("button", "New project");
    typeInto(byRole("textbox", "Project name"), "Garden");
    await click("button", "New");
    await vi.waitFor(() => expect(byText("Garden", "h1")).not.toBeNull());
    typeInto(byRole("textbox", "New task"), "Plant tulips");
    await click("button", "Add");
    await vi.waitFor(() => expect(rows()).toEqual(["Plant tulips"]));
    const project = (host.storage.get("projects") as Array<{ id: string }>)[0]!;
    await vi.waitFor(() => expect(stored(host)[0]?.projectId).toBe(project.id));
    await click("button", /All tasks/);
    typeInto(byRole("searchbox") ?? document.querySelector("input[type=search]"), "tulip");
    await vi.waitFor(() => expect(rows()).toEqual(["Plant tulips"]));
    await click("button", /Progress/);
    await vi.waitFor(() => expect(byText("0 of 1 done")).not.toBeNull());
  });

  it("reminds once when a task comes due", async () => {
    const task = createTask(
      { title: "Call the bank", due: todayKey(), dueTime: "00:00", remind: 0 },
      Date.now(),
    );
    const { host } = await start({ storage: { "tasks/3": [task] } });
    await vi.waitFor(() =>
      expect(host.notifications).toEqual([expect.objectContaining({ title: "Call the bank" })]),
    );
    expect(host.storage.get("reminded")).toHaveLength(1);
  });

  it("opens the task a widget asks for", async () => {
    const task = createTask(
      { title: "Renew passport", recurrence: makeRecurrence("year", todayKey()) },
      Date.now(),
    );
    const { host } = await start({ storage: { "tasks/1": [task] } });
    await vi.waitFor(() => expect(byRole("button", /Inbox/)).not.toBeNull());
    host.emit("window.opened", { state: { taskId: task.id } });
    await vi.waitFor(() =>
      expect((byRole("textbox", "Title") as HTMLInputElement | null)?.value).toBe("Renew passport"),
    );
  });
});

describe("the widget", () => {
  it("lists today's tasks, checks them off and adds one", async () => {
    const task = createTask({ title: "Laundry", due: todayKey() }, Date.now());
    const { host } = await start(
      {
        kind: "widget",
        widgetId: "today",
        granted: ["storage:app"],
        storage: { "tasks/2": [task] },
      },
      TaskWidget,
    );
    await vi.waitFor(() => expect(byText("Laundry")).not.toBeNull());
    await click("checkbox", "Mark “Laundry” as done");
    await vi.waitFor(() => expect(stored(host)[0]!.completedAt).not.toBeNull());
    const input = byRole("textbox", "New task") as HTMLInputElement;
    typeInto(input, "Buy bread");
    input.form!.requestSubmit();
    await vi.waitFor(() => expect(stored(host).map((entry) => entry.title)).toContain("Buy bread"));
    byText("Buy bread", "button")!.click();
    await vi.waitFor(() =>
      expect(host.calls.find((call) => call.method === "window.open")?.params).toMatchObject({
        state: { taskId: expect.any(String) },
      }),
    );
  });
});
