import type { MockHostOptions } from "@everyos/app-testing";
import { byRole, byText, pressKey, typeInto } from "@everyos/app-testing/dom";
import { renderApp, type RenderedApp } from "@everyos/app-ui/testing";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CalendarApp } from "../src/calendar-app.tsx";
import type { CalendarEvent } from "../src/model.ts";
import { UpcomingWidget } from "../src/upcoming-widget.tsx";

// A fixed place and time: Istanbul (UTC+3 all year), Wednesday 21 October 2026, 10:00.
process.env.TZ = "Europe/Istanbul";
beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-21T07:00:00Z"));
});
afterAll(() => vi.useRealTimers());

const publicDir = join(import.meta.dirname, "../public");
let rendered: RenderedApp | null = null;
afterEach(() => {
  rendered?.unmount();
  rendered = null;
});
const settle = () => new Promise((resolve) => setTimeout(resolve));

function stored(fields: Partial<CalendarEvent>): CalendarEvent {
  return {
    id: "standup",
    uid: "standup@test",
    calendarId: "personal",
    title: "Standup",
    allDay: false,
    start: "2026-10-21T14:00",
    end: "2026-10-21T14:30",
    timeZone: "Europe/Istanbul",
    location: "",
    notes: "",
    rrule: null,
    exdates: [],
    reminders: [],
    createdAt: 1,
    updatedAt: 1,
    ...fields,
  };
}

async function start(options: MockHostOptions = {}) {
  rendered = await renderApp(CalendarApp, {
    publicDir,
    app: { id: "dev.everyos.calendar", version: "1.0.0", name: "Calendar" },
    granted: ["storage:app", "notifications:send", "files:pick", "files:save"],
    ...options,
  });
  await vi.waitFor(() => expect(document.querySelector(".cal-app")).not.toBeNull());
  await settle();
  return rendered;
}

async function click(role: string, name: string | RegExp) {
  await vi.waitFor(() => expect(byRole(role, name)).not.toBeNull());
  await settle();
  byRole(role, name)!.click();
}

const events = (host: RenderedApp["host"]) =>
  [...host.storage.entries()]
    .filter(([key]) => key.startsWith("events/"))
    .flatMap(([, value]) => value as CalendarEvent[]);

/** The start time field (time inputs have no textbox role). */
const startTime = () => document.querySelector<HTMLInputElement>('input[type="time"]')!;
/** A button of the dialog with this title (dialogs stack: the event's and the scope question). */
async function clickInDialog(title: string, name: string) {
  const find = () =>
    [...document.querySelectorAll<HTMLElement>("dialog, [role=dialog]")]
      .find((dialog) => dialog.textContent?.includes(title))
      ?.querySelectorAll<HTMLButtonElement>("button") ?? [];
  const button = () => [...(find() ?? [])].find((entry) => entry.textContent === name) ?? null;
  await vi.waitFor(() => expect(button()).not.toBeNull());
  await settle();
  button()!.click();
}
const chipTitles = () =>
  [...document.querySelectorAll(".cal-chip-title")].map((chip) => chip.textContent);

describe("Calendar", () => {
  it("shows the month and adds an event through the dialog", async () => {
    const { host } = await start();
    expect(byText("October 2026")).not.toBeNull();
    expect(byRole("button", "Wednesday, 21 October 2026")?.getAttribute("aria-current")).toBe(
      "date",
    );
    await click("button", "New event");
    await vi.waitFor(() => expect(byRole("textbox", "Title")).not.toBeNull());
    typeInto(byRole("textbox", "Title"), "Dentist");
    // Starts at the next hour, for an hour, with a 10-minute reminder.
    expect(startTime().value).toBe("11:00");
    expect(byText("10 minutes before", "option")).not.toBeNull();
    typeInto(byRole("textbox", "Location"), "Clinic");
    await click("button", "Save");
    await vi.waitFor(() => expect(chipTitles()).toEqual(["Dentist"]));
    expect(events(host)).toMatchObject([
      {
        title: "Dentist",
        start: "2026-10-21T11:00",
        end: "2026-10-21T12:00",
        timeZone: "Europe/Istanbul",
        location: "Clinic",
        reminders: [10],
      },
    ]);
  });

  it("lays events out in the week and edits them", async () => {
    const { host } = await start({
      storage: {
        view: "week",
        "events/0": [
          stored({
            id: "a",
            title: "Design review",
            start: "2026-10-21T09:00",
            end: "2026-10-21T11:00",
          }),
          stored({ id: "b", title: "Lunch", start: "2026-10-21T10:00", end: "2026-10-21T12:00" }),
          stored({
            id: "c",
            title: "Holiday",
            allDay: true,
            start: "2026-10-23",
            end: "2026-10-24",
            timeZone: null,
          }),
        ],
      },
    });
    await vi.waitFor(() => expect(byText("19 – 25 October 2026")).not.toBeNull());
    const review = byRole("button", "Design review, 09:00 – 11:00")!;
    const lunch = byRole("button", "Lunch, 10:00 – 12:00")!;
    expect(review.style.top).toBe("432px");
    expect(review.style.width).toBe("calc(50% - 4px)");
    expect(lunch.style.left).toBe("calc(50% + 2px)");
    expect(chipTitles()).toEqual(["Holiday"]);
    expect(document.querySelector(".cal-now")).not.toBeNull();

    lunch.click();
    await vi.waitFor(() =>
      expect((byRole("textbox", "Title") as HTMLInputElement).value).toBe("Lunch"),
    );
    typeInto(byRole("textbox", "Title"), "Team lunch");
    await click("button", "Save");
    await vi.waitFor(() => expect(byRole("button", "Team lunch, 10:00 – 12:00")).not.toBeNull());
    expect(events(host).find((event) => event.id === "b")?.title).toBe("Team lunch");
  });

  it("changes one occurrence or ends a series", async () => {
    const { host } = await start({
      storage: {
        "events/0": [
          stored({
            title: "Gym",
            start: "2026-10-05T18:00",
            end: "2026-10-05T19:00",
            rrule: "FREQ=WEEKLY;BYDAY=MO",
          }),
        ],
      },
    });
    // The grid shows five Mondays of the series (5 October to 2 November).
    await vi.waitFor(() => expect(chipTitles().filter((title) => title === "Gym")).toHaveLength(5));
    // The occurrence on 19 October moves to 19:00, alone.
    const chip = [...document.querySelectorAll<HTMLButtonElement>(".cal-chip")].find((entry) =>
      entry.closest(".cal-day")?.querySelector('[aria-label="Monday, 19 October 2026"]'),
    )!;
    chip.click();
    await vi.waitFor(() => expect(startTime().value).toBe("18:00"));
    typeInto(startTime(), "19:00");
    await click("button", "Save");
    await clickInDialog("Change a repeating event", "Save");
    await vi.waitFor(() => expect(events(host)).toHaveLength(2));
    const [series, moved] = [
      events(host).find((event) => event.rrule)!,
      events(host).find((event) => !event.rrule)!,
    ];
    expect(series.exdates).toEqual(["2026-10-19T18:00"]);
    expect(moved).toMatchObject({
      title: "Gym",
      start: "2026-10-19T19:00",
      end: "2026-10-19T20:00",
    });

    // From 26 October on, no more gym.
    const late = [...document.querySelectorAll<HTMLButtonElement>(".cal-chip")].find((entry) =>
      entry.closest(".cal-day")?.querySelector('[aria-label="Monday, 26 October 2026"]'),
    )!;
    late.click();
    await click("button", "Delete");
    await vi.waitFor(() => expect(byText("Delete a repeating event")).not.toBeNull());
    await settle();
    document.querySelectorAll<HTMLInputElement>('input[name="scope"]')[1]!.click();
    await clickInDialog("Delete a repeating event", "Delete");
    await vi.waitFor(() =>
      expect(events(host).find((event) => event.rrule)?.rrule).toBe(
        "FREQ=WEEKLY;BYDAY=MO;UNTIL=20261026T175900Z",
      ),
    );
    await vi.waitFor(() => expect(chipTitles().filter((title) => title === "Gym")).toHaveLength(3));
  });

  it("searches every calendar and opens what it finds", async () => {
    await start({
      storage: {
        "events/0": [
          stored({
            id: "x",
            title: "Dentist",
            start: "2026-12-02T09:00",
            end: "2026-12-02T10:00",
            notes: "Bring the card",
          }),
          stored({ id: "y", title: "Concert" }),
        ],
      },
    });
    typeInto(
      byRole("searchbox", "Search events") ??
        document.querySelector<HTMLInputElement>('input[type="search"]')!,
      "card",
    );
    await vi.waitFor(() => expect(byText("Results for “card”")).not.toBeNull());
    expect(byText("Wednesday, 2 December 2026", "h3")).not.toBeNull();
    byText("Dentist", "strong")!.closest("button")!.click();
    await vi.waitFor(() =>
      expect((byRole("textbox", "Title") as HTMLInputElement).value).toBe("Dentist"),
    );
  });

  it("imports an .ics file into a new calendar and exports it again", async () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "X-WR-CALNAME:Work",
      "BEGIN:VEVENT",
      "UID:review@example.com",
      "DTSTART;TZID=Europe/Berlin:20261022T090000",
      "DTEND;TZID=Europe/Berlin:20261022T100000",
      "SUMMARY:Quarterly review",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const { host } = await start({ files: { "/work.ics": ics }, saveAs: () => "/out/work.ics" });
    await click("button", "Import .ics…");
    await vi.waitFor(() => expect(byText("The file has 1 event.")).not.toBeNull());
    await click("button", "Import 1 event");
    await vi.waitFor(() => expect(byText("Work", ".cal-calendar span")).not.toBeNull());
    // 09:00 in Berlin is 10:00 in Istanbul.
    await vi.waitFor(() => expect(chipTitles()).toEqual(["Quarterly review"]));
    expect(byText("10:00", ".cal-chip-time")).not.toBeNull();
    // Importing again updates instead of doubling.
    await click("button", "Import .ics…");
    await vi.waitFor(() => expect(byRole("combobox", "Import into")).not.toBeNull());
    const target = byRole("combobox", "Import into") as HTMLSelectElement;
    target.value = [...target.options].find((option) => option.text === "Work")!.value;
    target.dispatchEvent(new Event("change", { bubbles: true }));
    await click("button", "Import 1 event");
    await vi.waitFor(() => expect(byText("1 event imported into Work")).not.toBeNull());
    expect(events(host)).toHaveLength(1);

    await click("button", "Export Work as .ics");
    await vi.waitFor(() =>
      expect(host.readText("/out/work.ics")).toContain("SUMMARY:Quarterly review"),
    );
    expect(host.readText("/out/work.ics")).toContain("DTSTART;TZID=Europe/Berlin:20261022T090000");
  });

  it("hides calendars, moves with the keyboard and keeps the week start", async () => {
    const { host } = await start({
      locale: "tr",
      storage: { "events/0": [stored({ title: "Toplantı" })] },
    });
    await vi.waitFor(() => expect(chipTitles()).toEqual(["Toplantı"]));
    expect(byText("Pzt", ".cal-weekday")).not.toBeNull();
    document.querySelector<HTMLInputElement>(".cal-calendar input")!.click();
    await vi.waitFor(() => expect(chipTitles()).toEqual([]));
    await vi.waitFor(() =>
      expect(host.storage.get("calendars")).toMatchObject([{ visible: false }]),
    );
    pressKey("ArrowRight", {}, document.body);
    await vi.waitFor(() => expect(byText("Kasım 2026")).not.toBeNull());
    pressKey("t", {}, document.body);
    await vi.waitFor(() => expect(byText("Ekim 2026")).not.toBeNull());
    pressKey("w", {}, document.body);
    await vi.waitFor(() => expect(byText("19 – 25 Ekim 2026")).not.toBeNull());
  });

  it("reminds before events, once", async () => {
    const { host } = await start({
      storage: {
        "events/0": [
          stored({
            title: "Call the bank",
            start: "2026-10-21T10:10",
            end: "2026-10-21T10:30",
            reminders: [15],
          }),
        ],
      },
    });
    await vi.waitFor(() =>
      expect(host.notifications).toMatchObject([
        { title: "Call the bank", body: "10:10, Wednesday, 21 October 2026" },
      ]),
    );
    await vi.waitFor(() => expect(host.storage.get("reminded")).toHaveLength(1));
  });
});

describe("Upcoming events widget", () => {
  it("lists the coming events and opens one in the Calendar", async () => {
    rendered = await renderApp(UpcomingWidget, {
      publicDir,
      app: { id: "dev.everyos.calendar", version: "1.0.0", name: "Calendar" },
      kind: "widget",
      widgetId: "upcoming",
      granted: ["storage:app", "notifications:send"],
      storage: {
        "events/0": [
          stored({ title: "Standup", rrule: "FREQ=DAILY" }),
          stored({
            id: "trip",
            title: "Trip",
            allDay: true,
            start: "2026-10-23",
            end: "2026-10-25",
            timeZone: null,
          }),
        ],
      },
    });
    await vi.waitFor(() => expect(byText("Today", "h3")).not.toBeNull());
    expect([...document.querySelectorAll("h3")].map((heading) => heading.textContent)).toEqual([
      "Today",
      "Tomorrow",
      "Friday",
      "Saturday",
      "Sunday",
      "Monday",
      "Tuesday",
    ]);
    expect(byText("Trip", ".cal-widget-title")).not.toBeNull();
    byText("Trip", ".cal-widget-title")!.closest("button")!.click();
    await vi.waitFor(() =>
      expect(rendered!.host.calls.find((call) => call.method === "window.open")?.params).toEqual({
        state: { date: "2026-10-23", eventId: "trip", key: "2026-10-23" },
      }),
    );
  });
});
