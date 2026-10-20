import { z } from "zod";
import { capabilityInfo, isAppCapability, type AppCapability } from "./capabilities.ts";
import { appBelongsTo, isAppId, isPublisherId } from "./ids.ts";
import { extensionOf, isPackagePath } from "./paths.ts";
import {
  APP_CATEGORIES,
  APP_LOCALES,
  APP_WIDGET_PLACEMENTS,
  APP_WIDGET_SIZES,
  MANIFEST_VERSION,
  type AppManifest,
} from "./types.ts";
import { isVersion, isVersionRange } from "./version.ts";

/*
 * The strict manifest schema for servers and tooling. Unknown keys are errors, every string and list
 * is bounded, and cross-field rules (widget permissions, locales, the publisher namespace) are
 * checked here so an installer never sees a half-valid manifest.
 */

const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine(
      (value) =>
        value.trim() === value &&
        [...value].every((char) => char.charCodeAt(0) >= 0x20 && char.charCodeAt(0) !== 0x7f),
      { message: "invalid-text" },
    );
const url = z.url({ protocol: /^https$/, message: "invalid-url" }).max(512);
const path = (extensions: readonly string[]) =>
  z.string().refine((value) => isPackagePath(value) && extensions.includes(extensionOf(value)), {
    message: "invalid-path",
  });
const capability = z.string().refine(isAppCapability, { message: "unknown-capability" });
const dimension = z.number().int().min(160).max(4096);

const WidgetSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  name: text(48),
  description: text(200),
  entry: path(["html"]),
  sizes: z.array(z.enum(APP_WIDGET_SIZES)).min(1).max(APP_WIDGET_SIZES.length),
  defaultSize: z.enum(APP_WIDGET_SIZES),
  placements: z.array(z.enum(APP_WIDGET_PLACEMENTS)).min(1).max(APP_WIDGET_PLACEMENTS.length),
  permissions: z.array(capability).max(16),
});

export const AppManifestSchema = z
  .strictObject({
    manifestVersion: z.literal(MANIFEST_VERSION),
    id: z.string().refine(isAppId, { message: "invalid-app-id" }),
    name: text(48),
    version: z.string().refine(isVersion, { message: "invalid-version" }),
    description: text(280),
    entry: path(["html"]),
    icon: path(["png", "webp", "svg"]),
    category: z.enum(APP_CATEGORIES),
    permissions: z.array(capability).max(24),
    window: z
      .strictObject({
        defaultWidth: dimension,
        defaultHeight: dimension,
        minWidth: dimension,
        minHeight: dimension,
        instances: z.enum(["single", "multiple"]),
      })
      .refine(
        (window) =>
          window.minWidth <= window.defaultWidth && window.minHeight <= window.defaultHeight,
        { message: "min-exceeds-default" },
      ),
    widgets: z.array(WidgetSchema).max(8),
    locales: z
      .strictObject({
        default: z.enum(APP_LOCALES),
        supported: z.array(z.enum(APP_LOCALES)).min(1).max(APP_LOCALES.length),
        path: z.string().refine(isPackagePath, { message: "invalid-path" }),
      })
      .optional(),
    minEveryOS: z.string().refine(isVersion, { message: "invalid-version" }).optional(),
    sdk: z.string().refine(isVersionRange, { message: "invalid-range" }),
    publisher: z.strictObject({
      id: z.string().refine(isPublisherId, { message: "invalid-publisher-id" }),
      name: text(64),
      url: url.optional(),
    }),
    license: text(64).optional(),
    homepage: url.optional(),
    source: url.optional(),
    integration: z.strictObject({ adapter: z.string().regex(/^[a-z][a-z0-9-]{1,31}$/) }).optional(),
  })
  .superRefine((manifest, ctx) => {
    const issue = (message: string, path: (string | number)[]) =>
      ctx.addIssue({ code: "custom", message, path });
    if (!appBelongsTo(manifest.id, manifest.publisher.id))
      issue("app-outside-publisher-namespace", ["id"]);
    if (new Set(manifest.permissions).size !== manifest.permissions.length)
      issue("duplicate-permission", ["permissions"]);
    const integrations = manifest.permissions.filter((p) => p.startsWith("integration:"));
    if (integrations.length && !manifest.integration)
      issue("integration-capability-without-integration", ["permissions"]);
    if (
      manifest.integration &&
      !integrations.includes(`integration:${manifest.integration.adapter}`)
    )
      issue("integration-not-requested", ["integration"]);
    if (manifest.widgets.length && !manifest.permissions.includes("widgets:register"))
      issue("widgets-need-widgets-register", ["widgets"]);
    const widgetIds = new Set<string>();
    manifest.widgets.forEach((widget, index) => {
      if (widgetIds.has(widget.id)) issue("duplicate-widget", ["widgets", index, "id"]);
      widgetIds.add(widget.id);
      if (!widget.sizes.includes(widget.defaultSize))
        issue("default-size-not-supported", ["widgets", index, "defaultSize"]);
      for (const permission of widget.permissions)
        if (!manifest.permissions.includes(permission))
          issue("widget-permission-not-in-app", ["widgets", index, "permissions"]);
    });
    if (manifest.locales) {
      if (new Set(manifest.locales.supported).size !== manifest.locales.supported.length)
        issue("duplicate-locale", ["locales", "supported"]);
      if (!manifest.locales.supported.includes(manifest.locales.default))
        issue("default-locale-not-supported", ["locales", "default"]);
    }
  });

export interface ManifestIssue {
  path: string;
  message: string;
}

export class ManifestError extends Error {
  readonly issues: ManifestIssue[];
  constructor(issues: ManifestIssue[]) {
    super(
      `Invalid app manifest: ${issues.map((i) => `${i.path || "(root)"} ${i.message}`).join("; ")}`,
    );
    this.name = "ManifestError";
    this.issues = issues;
  }
}

/** Parses and validates a manifest (the parsed JSON value), or throws a ManifestError. */
export function parseManifest(value: unknown): AppManifest {
  const result = AppManifestSchema.safeParse(value);
  if (!result.success)
    throw new ManifestError(
      result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    );
  return result.data as AppManifest;
}

/** Elevated capabilities in the manifest, which need an explicit administrator grant. */
export function elevatedCapabilities(manifest: Pick<AppManifest, "permissions">): AppCapability[] {
  return manifest.permissions.filter(
    (permission) => capabilityInfo(permission).risk === "elevated",
  );
}
