import {
  isPreferenceKey,
  shortcutIconId,
  THEME_PRESET_IDS,
  type PreferenceKey,
  type ShortcutPreferences,
} from "@everyos/shared";
import {
  EmptyDesktopQuerySchema,
  PreferenceParamsSchema,
  PREFERENCE_SCHEMAS,
  type AppearancePreferences,
} from "@everyos/shared/schemas";
import { Hono } from "hono";
import type { AppEnv } from "../../context.ts";
import { ApiError, notFound } from "../../http/errors.ts";
import { parseJsonBody, parseParams, parseQuery } from "../../http/validation.ts";
import { requirePermission, requireAuth } from "../../middleware/auth.ts";
import type { Services } from "../../services.ts";

function keyParam(value: string): PreferenceKey {
  if (!isPreferenceKey(value)) throw notFound("Preference");
  return value;
}

/** Cross-field rules that a per-field schema cannot express. */
function checkConsistency(
  services: Services,
  userId: string,
  key: PreferenceKey,
  value: unknown,
): void {
  if (key === "shortcuts") {
    const shortcuts = value as ShortcutPreferences;
    if (
      shortcuts.entries.some((entry) => {
        const id = entry.icon && shortcutIconId(entry.icon);
        return id && !services.wallpapers.file(userId, id, "folder-icon");
      })
    )
      throw new ApiError(400, "VALIDATION_FAILED", "Unknown shortcut icon");
    return;
  }
  if (key !== "appearance") return;
  const appearance = value as AppearancePreferences;
  const icons = [appearance.folderIcon, ...(appearance.folderIcons ?? []).map((item) => item.icon)];
  if (
    icons.some(
      (icon) =>
        icon?.kind === "uploaded" && !services.wallpapers.file(userId, icon.iconId, "folder-icon"),
    )
  ) {
    throw new ApiError(400, "VALIDATION_FAILED", "Unknown folder icon", {
      details: [{ path: "folderIcon", message: "unknown-folder-icon" }],
    });
  }
  const custom = appearance.themeId.startsWith("custom:") ? appearance.themeId.slice(7) : null;
  const known = custom
    ? appearance.customThemes.some((theme) => theme.id === custom)
    : (THEME_PRESET_IDS as readonly string[]).includes(appearance.themeId);
  if (!known) {
    throw new ApiError(400, "VALIDATION_FAILED", "Unknown theme", {
      details: [{ path: "themeId", message: "unknown-theme" }],
    });
  }
}

export function preferenceRoutes(services: Services): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", requirePermission("preferences:manage"));

  app.get("/", (c) => {
    const auth = requireAuth(c);
    parseQuery(c, EmptyDesktopQuerySchema);
    return c.json({ preferences: services.preferences.getAll(auth.user.id) });
  });

  app.put("/:key", async (c) => {
    const auth = requireAuth(c);
    const key = keyParam(c.req.param("key"));
    parseParams(c, PreferenceParamsSchema);
    const value: unknown = await parseJsonBody(c, PREFERENCE_SCHEMAS[key]);
    checkConsistency(services, auth.user.id, key, value);
    services.preferences.set(auth.user.id, key, value);
    if (key === "security" || key === "shortcuts")
      services.audit.record({
        action: `preferences.${key}.update`,
        outcome: "success",
        actor: { userId: auth.user.id, username: auth.user.username },
        ip: c.get("client").ip,
        target: auth.user.id,
      });
    return c.body(null, 204);
  });

  app.delete("/:key", (c) => {
    const auth = requireAuth(c);
    const key = keyParam(c.req.param("key"));
    parseParams(c, PreferenceParamsSchema);
    services.preferences.delete(auth.user.id, key);
    if (key === "security" || key === "shortcuts")
      services.audit.record({
        action: `preferences.${key}.reset`,
        outcome: "success",
        actor: { userId: auth.user.id, username: auth.user.username },
        ip: c.get("client").ip,
        target: auth.user.id,
      });
    return c.body(null, 204);
  });

  return app;
}
