import type { Migration } from "../migrator.ts";
import { migration0001 } from "./0001-initial.ts";
import { migration0002 } from "./0002-desktop.ts";
import { migration0003 } from "./0003-docker.ts";
import { migration0004 } from "./0004-catalogs.ts";
import { migration0005 } from "./0005-managed-apps.ts";

/** Ordered list of all Otuken schema migrations. Append only. */
export const OTUKEN_MIGRATIONS: readonly Migration[] = [
  migration0001,
  migration0002,
  migration0003,
  migration0004,
  migration0005,
];
