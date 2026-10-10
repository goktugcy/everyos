import type { Migration } from "../migrator.ts";
import { migration0001 } from "./0001-initial.ts";

/** Ordered list of all Otuken schema migrations. Append only. */
export const OTUKEN_MIGRATIONS: readonly Migration[] = [migration0001];
