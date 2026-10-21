/* The part of pg-cursor (no published types) the database connector uses. */
declare module "pg-cursor" {
  import type { CustomTypesConfig, FieldDef, Submittable } from "pg";

  interface CursorResult {
    fields: FieldDef[];
    command: string | null;
    rowCount: number | null;
  }

  class Cursor<Row = unknown[]> implements Submittable {
    constructor(
      text: string,
      values?: unknown[] | null,
      config?: { rowMode?: "array"; types?: CustomTypesConfig },
    );
    submit: Submittable["submit"];
    read(
      rows: number,
      callback: (error: Error | undefined, rows: Row[], result: CursorResult) => void,
    ): void;
    close(): Promise<void>;
  }

  export default Cursor;
}
