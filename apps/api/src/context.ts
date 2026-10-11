import type { HttpBindings } from "@hono/node-server";
import type { Logger } from "@everyos/logger";
import type { Permission } from "@everyos/shared";
import type { ClientInfo } from "./http/client-info.ts";
import type { Session } from "./modules/auth/session-service.ts";
import type { User } from "./modules/users/user-repository.ts";

export interface AuthState {
  user: User;
  session: Session;
  permissions: ReadonlySet<Permission>;
}

export interface AppVariables {
  requestId: string;
  logger: Logger;
  client: ClientInfo;
  auth: AuthState | null;
}

export interface AppEnv {
  Bindings: Partial<HttpBindings>;
  Variables: AppVariables;
}
