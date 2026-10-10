import type { Migration } from "../migrator.ts";
import { migration0001 } from "./0001-initial.ts";
import { migration0002 } from "./0002-desktop.ts";
import { migration0003 } from "./0003-docker.ts";

/** Ordered list of all Otuken schema migrations. Append only. */
export const OTUKEN_MIGRATIONS: readonly Migration[] = [
  migration0001,
  migration0002,
  migration0003,
];
