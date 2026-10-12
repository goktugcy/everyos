import { z } from "zod";
import { FileRootIdSchema, RelativePathSchema } from "./files.ts";
import type { WidgetPreferences } from "../widgets.ts";
import { WidgetPreferencesSchema } from "./widgets.ts";
import { NotificationPreferencesSchema, type NotificationPreferences } from "./notifications.ts";
import { PulsePreferencesSchema, type PulsePreferences } from "./pulse.ts";
import {
  AUTO_LOCK_MINUTES,
  DOCK_POSITIONS,
  DOCK_STYLES,
  FOLDER_ICON_PRESET_IDS,
  ICON_SIZES,
  MAX_DESKTOPS,
  MENUBAR_MODULE_IDS,
  PREFERENCE_KEYS,
  RENDER_MODES,
  THEME_PRESET_IDS,
  WALLPAPER_PRESET_IDS,
  WINDOW_ANIMATIONS,
  WINDOW_LAYOUTS,
  type PreferenceKey,
} from "../preferences.ts";

const HexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, "hex-color");
const IdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "id");
export const EmptyDesktopQuerySchema = z.strictObject({});
export const PreferenceParamsSchema = z.strictObject({ key: z.enum(PREFERENCE_KEYS) });
export const WallpaperParamsSchema = z.strictObject({ id: IdSchema });
export const WallpaperUploadHeadersSchema = z.strictObject({
  contentLength: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .pipe(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER))
    .optional(),
});
export const AppIdSchema = z
  .string()
  .max(64)
  .regex(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/, "app-id")
  .transform((id) => (id.startsWith("otuken.") ? `everyos.${id.slice(7)}` : id));

/* Appearance */

export const WallpaperSpecSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("preset"),
    id: z
      .enum([...WALLPAPER_PRESET_IDS, "otuken-dusk"])
      .transform((id) => (id === "otuken-dusk" ? "everyos-dusk" : id)),
  }),
  z.strictObject({
    kind: z.literal("gradient"),
    from: HexColorSchema,
    to: HexColorSchema,
    angle: z.number().int().min(0).max(360),
  }),
  z.strictObject({ kind: z.literal("solid"), color: HexColorSchema }),
  z.strictObject({
    kind: z.literal("image"),
    wallpaperId: IdSchema,
    fit: z.enum(["cover", "contain"]),
  }),
]);

export type WallpaperSpec = z.infer<typeof WallpaperSpecSchema>;

export const FolderIconSpecSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("preset"), id: z.enum(FOLDER_ICON_PRESET_IDS) }),
  z.strictObject({ kind: z.literal("uploaded"), iconId: IdSchema }),
]);
export type FolderIconSpec = z.infer<typeof FolderIconSpecSchema>;

const FolderIconOverrideSchema = z.strictObject({
  root: FileRootIdSchema,
  path: RelativePathSchema.refine(
    (path) => path.length > 0 && path.split("/").every(Boolean),
    "invalid-path",
  ),
  icon: FolderIconSpecSchema,
});

export const ThemeEffectsSchema = z.strictObject({
  surfaceOpacity: z.number().min(0.3).max(1),
  blur: z.number().min(0).max(40),
  borderIntensity: z.number().min(0).max(1),
  shadowIntensity: z.number().min(0).max(1),
  radius: z.number().min(4).max(32),
});

export type ThemeEffects = z.infer<typeof ThemeEffectsSchema>;

export const CustomThemeSchema = z.strictObject({
  id: IdSchema,
  name: z.string().trim().min(1).max(40),
  base: z.enum(THEME_PRESET_IDS),
  accent: HexColorSchema,
  effects: ThemeEffectsSchema.partial(),
  wallpaper: WallpaperSpecSchema.nullable(),
});

export type CustomTheme = z.infer<typeof CustomThemeSchema>;

export const AppearancePreferencesSchema = z.strictObject({
  version: z.literal(1),
  /** A preset id or "custom:<id>" referring to an entry in customThemes. */
  themeId: z.string().max(80),
  accent: HexColorSchema.nullable(),
  effects: ThemeEffectsSchema.partial(),
  fontScale: z.number().min(0.85).max(1.3),
  iconSize: z.enum(ICON_SIZES),
  renderMode: z.enum(RENDER_MODES),
  windowAnimation: z.enum(WINDOW_ANIMATIONS),
  wallpaper: WallpaperSpecSchema.nullable(),
  wallpaperAnimated: z.boolean(),
  customThemes: z.array(CustomThemeSchema).max(20),
  /** Optional so existing documents keep their original folder appearance. */
  folderIcon: FolderIconSpecSchema.optional(),
  folderIcons: z
    .array(FolderIconOverrideSchema)
    .max(500)
    .refine(
      (icons) => new Set(icons.map((icon) => `${icon.root}/${icon.path}`)).size === icons.length,
      "duplicate-folder",
    )
    .optional(),
});

export type AppearancePreferences = z.infer<typeof AppearancePreferencesSchema>;

/* Desktop (icons, folders, virtual desktops) */

const CellSchema = z.strictObject({
  col: z.number().int().min(0).max(63),
  row: z.number().int().min(0).max(63),
});

export const DesktopItemSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("app"),
    id: IdSchema,
    appId: AppIdSchema,
    desktopId: IdSchema,
    cell: CellSchema.nullable(),
    /** Legacy app group the shortcut was in (always null for new items). */
    folderId: IdSchema.nullable(),
  }),
  /*
   * Legacy app groups from before the desktop became a real folder. They are
   * still accepted so older documents load; the desktop turns each into a real
   * folder in the home's Desktop folder and moves its shortcuts back out.
   */
  z.strictObject({
    kind: z.literal("folder"),
    id: IdSchema,
    name: z.string().trim().min(1).max(40),
    desktopId: IdSchema,
    cell: CellSchema.nullable(),
  }),
]);

export type DesktopItem = z.infer<typeof DesktopItemSchema>;

/** Where an entry of the home's Desktop folder sits on the grid (by name, on every desktop). */
export const DesktopFilePositionSchema = z.strictObject({
  name: z.string().min(1).max(255),
  cell: CellSchema,
});

export type DesktopFilePosition = z.infer<typeof DesktopFilePositionSchema>;

export const VirtualDesktopSchema = z.strictObject({
  id: IdSchema,
  name: z.string().trim().min(1).max(32),
  wallpaper: WallpaperSpecSchema.nullable(),
});

export type VirtualDesktop = z.infer<typeof VirtualDesktopSchema>;

export const DesktopPreferencesSchema = z.strictObject({
  version: z.literal(1),
  desktops: z.array(VirtualDesktopSchema).min(1).max(MAX_DESKTOPS),
  items: z.array(DesktopItemSchema).max(300),
  files: z.array(DesktopFilePositionSchema).max(500).default([]),
  applicationsFolderAdded: z.boolean().optional(),
});

export type DesktopPreferences = z.infer<typeof DesktopPreferencesSchema>;

/* Dock */

export const DockPreferencesSchema = z.strictObject({
  version: z.literal(1),
  pinned: z.array(AppIdSchema).max(32),
  style: z.enum(DOCK_STYLES),
  position: z.enum(DOCK_POSITIONS),
  iconSize: z.number().int().min(32).max(72),
  magnification: z.boolean(),
  autoHide: z.boolean(),
  opacity: z.number().min(0.3).max(1),
});

export type DockPreferences = z.infer<typeof DockPreferencesSchema>;

/* Menu bar */

export const MenubarPreferencesSchema = z.strictObject({
  version: z.literal(1),
  hidden: z.array(z.enum(MENUBAR_MODULE_IDS)).max(MENUBAR_MODULE_IDS.length),
  clockSeconds: z.boolean(),
});

export type MenubarPreferences = z.infer<typeof MenubarPreferencesSchema>;

/* Window session (restored after reload) */

const Coordinate = z.number().min(-20_000).max(20_000);

export const PersistedWindowSchema = z.strictObject({
  id: IdSchema,
  appId: AppIdSchema,
  desktopId: IdSchema,
  title: z.string().max(120),
  bounds: z.strictObject({
    x: Coordinate,
    y: Coordinate,
    width: z.number().min(1).max(20_000),
    height: z.number().min(1).max(20_000),
  }),
  layout: z.enum(WINDOW_LAYOUTS),
  minimized: z.boolean(),
  z: z.number().int().min(0).max(1_000_000_000),
  appState: z.unknown().optional(),
});

export type PersistedWindow = z.infer<typeof PersistedWindowSchema>;

export const WindowSessionSchema = z.strictObject({
  version: z.literal(1),
  viewport: z.strictObject({
    width: z.number().min(1).max(20_000),
    height: z.number().min(1).max(20_000),
  }),
  activeDesktopId: IdSchema,
  windows: z.array(PersistedWindowSchema).max(40),
});

export type WindowSession = z.infer<typeof WindowSessionSchema>;

/* Session security */

export const SecurityPreferencesSchema = z.strictObject({
  version: z.literal(1),
  autoLockMinutes: z.union(AUTO_LOCK_MINUTES.map((value) => z.literal(value))),
});

export type SecurityPreferences = z.infer<typeof SecurityPreferencesSchema>;

/** Schema registry used by the preferences API. */
export const PREFERENCE_SCHEMAS: Record<PreferenceKey, z.ZodType> = {
  appearance: AppearancePreferencesSchema,
  desktop: DesktopPreferencesSchema,
  dock: DockPreferencesSchema,
  menubar: MenubarPreferencesSchema,
  windows: WindowSessionSchema,
  security: SecurityPreferencesSchema,
  widgets: WidgetPreferencesSchema,
  notifications: NotificationPreferencesSchema,
  pulse: PulsePreferencesSchema,
};

export interface PreferenceDocuments {
  appearance: AppearancePreferences;
  desktop: DesktopPreferences;
  dock: DockPreferences;
  menubar: MenubarPreferences;
  windows: WindowSession;
  security: SecurityPreferences;
  widgets: WidgetPreferences;
  notifications: NotificationPreferences;
  pulse: PulsePreferences;
}

export const UnlockRequestSchema = z.strictObject({
  password: z.string().min(1).max(256),
});
