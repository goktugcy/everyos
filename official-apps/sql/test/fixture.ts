import type { DbQueryResult, DbTable } from "@everyos/app-sdk";
export const result = (): DbQueryResult => ({
  command: "SELECT",
  columns: [{ name: "name", type: "text" }],
  rows: [["Ada"], ["Grace"]],
  rowCount: 2,
  truncated: false,
  ms: 4,
  readOnly: true,
});
export const table: DbTable = {
  schema: "public",
  name: "contacts",
  kind: "table",
  columns: [{ name: "name", type: "text", nullable: false }],
};
