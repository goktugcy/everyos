import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isAppId, isPublisherId } from "@everyos/app-manifest";
import { SDK_VERSION } from "@everyos/app-sdk/protocol";
import { EVERYOS_VERSION } from "@everyos/shared";

/*
 * create-everyos-app: a new app project from one of the templates, ready for `npm install` and
 * `npm run dev`. The SDK packages come from the EveryOS release (`.tgz` files attached to it)
 * unless `packages` says where else to take them from (another release, a local checkout, npm).
 */

export const TEMPLATES = ["vanilla", "react", "react-widget", "hybrid"] as const;
export type Template = (typeof TEMPLATES)[number];

const here = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = join(here, "..", "templates");
const TEXT = /\.(?:json|ts|tsx|html|css|md)$|^_gitignore$/;

/** Where the SDK packages of this EveryOS release are published (the release's own files). */
export const RELEASE_PACKAGES = `https://github.com/goktugcy/everyos/releases/download/v${EVERYOS_VERSION}`;

export interface CreateOptions {
  dir: string;
  template: Template;
  /** Default: `com.example.<folder name>`. */
  id?: string;
  name?: string;
  publisherId?: string;
  publisherName?: string;
  /**
   * How package.json names the SDK packages: a base URL or directory holding the `.tgz` files
   * (`everyos-app-sdk-<version>.tgz` …), `npm` for registry versions, or exact specs.
   */
  packages?: string | { sdk: string; cli: string; testing: string };
}

export class CreateError extends Error {}

function specs(packages: CreateOptions["packages"]): { sdk: string; cli: string; testing: string } {
  if (packages && typeof packages === "object") return packages;
  if (packages === "npm")
    return { sdk: `^${SDK_VERSION}`, cli: `^${SDK_VERSION}`, testing: `^${SDK_VERSION}` };
  const base = (packages ?? RELEASE_PACKAGES).replace(/\/$/, "");
  const at = (name: string) =>
    /^https?:\/\//.test(base)
      ? `${base}/${name}-${SDK_VERSION}.tgz`
      : `file:${resolve(base, `${name}-${SDK_VERSION}.tgz`)}`;
  return {
    sdk: at("everyos-app-sdk"),
    cli: at("everyos-app-cli"),
    testing: at("everyos-app-testing"),
  };
}

/** A readable app name from a folder name (`my-notes` → `My notes`). */
const titled = (slug: string) => {
  const words = slug.replace(/[-_]+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : "My app";
};

export async function createProject(options: CreateOptions): Promise<{ dir: string; id: string }> {
  if (!TEMPLATES.includes(options.template))
    throw new CreateError(`Unknown template "${options.template}" (${TEMPLATES.join(", ")})`);
  const dir = resolve(options.dir);
  if (existsSync(dir) && (await readdir(dir)).length) throw new CreateError(`${dir} is not empty`);
  const slug = basename(dir)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^(\d)/, "app-$1");
  const publisherId = options.publisherId ?? "com.example";
  const id = options.id ?? `${publisherId}.${slug || "app"}`;
  const shown: string = publisherId;
  if (!isPublisherId(publisherId)) throw new CreateError(`"${shown}" is not a publisher id`);
  if (!isAppId(id) || !id.startsWith(`${publisherId}.`))
    throw new CreateError(
      `"${id}" is not an app id under ${publisherId} (like ${publisherId}.notes)`,
    );
  const name = (options.name ?? titled(slug)).slice(0, 64);
  const packages = specs(options.packages);
  const tokens: Record<string, string> = {
    APP_ID: id,
    APP_NAME: name,
    PACKAGE_NAME: slug || "everyos-app",
    PUBLISHER_ID: publisherId,
    PUBLISHER_NAME: (options.publisherName ?? "Example").slice(0, 64),
    SDK: packages.sdk,
    CLI: packages.cli,
    TESTING: packages.testing,
    SDK_VERSION,
    MIN_EVERYOS: EVERYOS_VERSION,
    TEMPLATE: options.template,
  };
  await mkdir(dir, { recursive: true });
  await cp(join(TEMPLATE_DIR, options.template), dir, { recursive: true });
  const fill = async (current: string) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await fill(path);
      else if (TEXT.test(entry.name)) {
        const text = await readFile(path, "utf8");
        await writeFile(
          path,
          text.replace(/%%([A-Z_]+)%%/g, (match, key: string) =>
            // JSON strings stay valid whatever the name holds.
            key in tokens ? JSON.stringify(tokens[key]).slice(1, -1) : match,
          ),
        );
      }
    }
  };
  await fill(dir);
  await rename(join(dir, "_gitignore"), join(dir, ".gitignore"));
  return { dir, id };
}
