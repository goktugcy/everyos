import { BridgeError, type DbConnection, type DbQueryResult } from "@everyos/app-sdk";
import type { MockHostOptions } from "@everyos/app-testing";
import { byRole, byText, typeInto } from "@everyos/app-testing/dom";
import { renderApp, typeInEditor, type RenderedApp } from "@everyos/app-ui/testing";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqlApp } from "../src/sql-app.tsx";
import { result, table } from "./fixture.ts";

const connection: DbConnection = {
  id: "db-1",
  name: "Contacts",
  engine: "postgres",
  host: "db.test",
  port: 5432,
  database: "contacts",
  access: "write",
};
const granted = ["database:connect", "storage:app", "files:save"];
let rendered: RenderedApp | null = null;
afterEach(() => {
  rendered?.unmount();
  rendered = null;
});
async function start(options: MockHostOptions = {}) {
  rendered = await renderApp(SqlApp, {
    publicDir: join(import.meta.dirname, "../public"),
    granted,
    host: {
      "db.connections": () => ({ connections: [connection] }),
      "db.tables": () => ({ tables: [table], truncated: false }),
      "db.query": () => result(),
      "db.test": () => ({ version: "PostgreSQL fixture", ms: 3 }),
    },
    ...options,
  });
  await vi.waitFor(() => expect(byRole("button", "Run query")).not.toBeNull());
  await vi.waitFor(() => expect(byRole("button", "public.contacts")).not.toBeNull());
  await new Promise((done) => setTimeout(done));
  return rendered;
}
async function click(name: string) {
  await new Promise((done) => setTimeout(done));
  expect(byRole("button", name)).not.toBeNull();
  byRole("button", name)!.click();
}
const calls = () =>
  rendered!.host.calls
    .filter((call) => call.method === "host.call")
    .map((call) => call.params as { operation: string; input: unknown });
describe("SQL Client", () => {
  it("browses columns, runs with read-only defaults and exports the returned snapshot", async () => {
    const { host } = await start();
    await click("public.contacts");
    expect(byText("text")).not.toBeNull();
    typeInto(byRole("textbox", "Parameters as a JSON array"), '["Ada"]');
    await click("Run query");
    await vi.waitFor(() =>
      expect(document.querySelector('table[aria-label="Query results"]')?.textContent).toContain(
        "Ada",
      ),
    );
    expect(calls()).toContainEqual({
      operation: "db.query",
      input: {
        connection: "db-1",
        sql: 'SELECT * FROM "public"."contacts"',
        params: ["Ada"],
        maxRows: 500,
        timeoutMs: 30000,
        write: false,
      },
    });
    await click("Export results as CSV");
    await vi.waitFor(() => expect(host.readText("/query-results.csv")).toContain('"Grace"'));
    expect([...host.storage.keys()].every((key) => key === "preferences.v1")).toBe(true);
  });
  it("validates parameters before making a query and reports real database details as text", async () => {
    await start({
      host: {
        "db.connections": () => ({ connections: [connection] }),
        "db.tables": () => ({ tables: [table], truncated: false }),
        "db.query": () => {
          throw new BridgeError("DESKTOP_APP_DB_FAILED", "Internal", {
            code: "42601",
            message: "<script>bad SQL</script>",
            position: 7,
          });
        },
      },
    });
    typeInEditor("SELECT $1", { replace: true });
    typeInto(byRole("textbox", "Parameters as a JSON array"), "[{}]");
    await click("Run query");
    expect(calls().some((call) => call.operation === "db.query")).toBe(false);
    expect(byRole("alert")).not.toBeNull();
    typeInto(byRole("textbox", "Parameters as a JSON array"), "[]");
    await click("Run query");
    await vi.waitFor(() => expect(byText(/Database 42601/)).not.toBeNull());
    expect(document.querySelector("script")).toBeNull();
  });
  it("tests a saved connection and keeps SQL history only for this session", async () => {
    const { host } = await start();
    await click("Test connection");
    await vi.waitFor(() => expect(byText(/PostgreSQL fixture/)).not.toBeNull());
    typeInEditor("SELECT 'private draft'", { replace: true });
    await click("Run query");
    await vi.waitFor(() => expect(document.querySelector(".sql-history button")).not.toBeNull());
    host.emit("lifecycle.suspend", null);
    await new Promise((done) => setTimeout(done, 20));
    expect(JSON.stringify([...host.storage])).not.toContain("private draft");
    expect(JSON.stringify([...host.storage])).not.toContain("Ada");
    await click("Clear history");
    await vi.waitFor(() => expect(document.querySelector(".sql-history button")).toBeNull());
  });
  it("requires explicit write selection for every resumed session and history replay", async () => {
    await start();
    await click("public.contacts");
    byRole("checkbox", "Request a write for this query")!.click();
    await click("Run query");
    await vi.waitFor(() =>
      expect(calls().some((call) => call.operation === "db.query")).toBe(true),
    );
    expect(calls().find((call) => call.operation === "db.query")!.input).toMatchObject({
      write: true,
    });
    rendered!.host.emit("lifecycle.suspend", null);
    await vi.waitFor(() =>
      expect(
        (byRole("checkbox", "Request a write for this query") as HTMLInputElement).checked,
      ).toBe(false),
    );
    rendered!.host.emit("lifecycle.resume", null);
    byRole("checkbox", "Request a write for this query")!.click();
    document.querySelector<HTMLButtonElement>(".sql-history button")!.click();
    await vi.waitFor(() =>
      expect(
        (byRole("checkbox", "Request a write for this query") as HTMLInputElement).checked,
      ).toBe(false),
    );
  });
  it("ignores late results and removes sensitive session data after capability revocation", async () => {
    let resolve: ((value: DbQueryResult) => void) | undefined;
    const { host } = await start({
      host: {
        "db.connections": () => ({ connections: [connection] }),
        "db.tables": () => ({ tables: [table], truncated: false }),
        "db.query": () =>
          new Promise<DbQueryResult>((done) => {
            resolve = done;
          }),
      },
    });
    await click("public.contacts");
    await click("Run query");
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    host.setGranted(["storage:app", "files:save"]);
    await vi.waitFor(() => expect(byText(/Database access is unavailable/)).not.toBeNull());
    resolve!(result());
    await new Promise((done) => setTimeout(done, 20));
    expect(document.querySelector('table[aria-label="Query results"]')).toBeNull();
    expect(document.querySelector(".sql-history button")).toBeNull();
  });
});
