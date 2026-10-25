import { publishIndex } from "./publication.ts";
import { audit, stmt } from "./storage.ts";
export async function scheduled(_controller: ScheduledController, env: Env): Promise<void> {
  await env.DB.batch([
    stmt(env, "DELETE FROM rate_limits WHERE expires_at < ?", Date.now()),
    stmt(env, "DELETE FROM invitations WHERE expires_at < ?", Date.now() - 86400000),
    stmt(env, "DELETE FROM tokens WHERE expires_at < ? OR revoked = 1", Date.now()),
    stmt(
      env,
      "UPDATE registry_state SET revision = revision + 1, updated_at = ? WHERE id = 1 AND expires_at < ?",
      Date.now(),
      Date.now() + 7 * 86400000,
    ),
    audit(env, "system", "catalog.maintained", "community"),
  ]);
  await publishIndex(env);
}
