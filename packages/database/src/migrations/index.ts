import type { Migration } from "../migrator.ts";
import { migration0001 } from "./0001-initial.ts";
import { migration0002 } from "./0002-desktop.ts";
import { migration0003 } from "./0003-docker.ts";
import { migration0004 } from "./0004-catalogs.ts";
import { migration0005 } from "./0005-managed-apps.ts";
import { migration0006 } from "./0006-app-details.ts";
import { migration0007 } from "./0007-integrations.ts";
import { migration0008 } from "./0008-notifications.ts";
import { migration0009 } from "./0009-update-jobs.ts";
import { migration0010 } from "./0010-scheduled-tasks.ts";
import { migration0011 } from "./0011-ai-agents.ts";
import { migration0012 } from "./0012-ai-local-models.ts";
import { migration0013 } from "./0013-ai-chat-lists.ts";

/** Ordered list of all EveryOS schema migrations. Append only. */
export const EVERYOS_MIGRATIONS: readonly Migration[] = [
  migration0001,
  migration0002,
  migration0003,
  migration0004,
  migration0005,
  migration0006,
  migration0007,
  migration0008,
  migration0009,
  migration0010,
  migration0011,
  migration0012,
  migration0013,
];
