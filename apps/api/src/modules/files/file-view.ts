import type { Logger } from "@everyos/logger";
import type { Permission } from "@everyos/shared";
import type { UserActor } from "../../http/agent.ts";
import type { Services } from "../../services.ts";
import { AccountFileView } from "./account-file-view.ts";
import { readFileSettings } from "./file-settings.ts";

/** The person a file view belongs to. */
export interface FileUser {
  user: { id: string; username: string; locale: string };
  permissions: ReadonlySet<Permission>;
  actor: UserActor;
}

/**
 * A person's view of the files: their home, the configured locations and, for administrators
 * who enabled them, system paths. Production reaches host locations as the linked Linux account.
 * Works inside a request and in background work such as transfers.
 */
export function fileViewFor(
  services: Services,
  who: FileUser,
  options: { signal?: AbortSignal | undefined; logger: Logger },
) {
  const systemRoots =
    who.permissions.has("system:manage") && readFileSettings(services.db).systemRoots;
  const personal = services.files.view({
    id: who.user.id,
    username: who.user.username,
    locale: who.user.locale,
    personalOnly: services.config.mode === "production",
    systemRoots,
  });
  return services.config.mode === "production"
    ? new AccountFileView(services, personal, {
        actor: who.actor,
        locale: who.user.locale === "en" ? "en" : "tr",
        systemRoots,
        signal: options.signal,
        logger: options.logger,
      })
    : personal;
}

export type FileView = ReturnType<typeof fileViewFor>;
